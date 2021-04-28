'use strict';

const _      = require('lodash');
const P      = require('bluebird');
const bunyan = require('bunyan');

/**
 * ValidationError is expected to be thrown during event validation.
 */
const ValidationError = require('./error').ValidationError;

/**
 * Represents an EventGate process status result.
 * Each event passed to EventGate process() will map
 * to an final EventStatus.  If the status is a failure
 * this.context should contain the Error.
 */
class EventStatus {
    /**
     * @param {string} status One of EventStatus.STATUSES.
     * @param {Object} context Event status context, possibly an Error.
     * @param {Object} event Event which this EventStatus represents status for.
     */
    constructor(status, context, event) {
        // validate that status is a valid status
        if (!EventStatus.STATUSES.includes(status)) {
            throw new Error(`Cannot instantiate EventStatus with status ${status}`);
        }

        this.status = status;
        this.context = context;
        this.event = event;
    }

    /**
     * Will be called if returned in an HTTP response body.
     * If this.context is an Error, it will be cleaned up
     * so that internal details are not potentially exposed.
     *
     * @return {Object}
     */
    toJSON() {
        let context;
        if (this.context instanceof Error && !(this.context instanceof ValidationError)) {
            // If context is an Error but not an ValidationError, then
            // only return context with the error message.
            context = {
                message: this.context.message
            };
        } else {
            // Else we can trust context, keep it.
            context = this.context;
        }

        return {
            status: this.status,
            event: this.event,
            context
        };
    }
}
/**
 * 'static' 'enum' constant for possible status types.
 */
EventStatus.STATUSES = [
    'success',
    'error',
    'invalid'
];

const defaultOptions = {
    eventRepr: (event, context) => { return 'event'; },
    mapToErrorEvent: undefined,
    // This logger will be used if one is not provided to EventValidator constructor.
    log: bunyan.createLogger(
        { name: 'EventGate', src: true, level: 'info' }
    )
};

/**
 * An EventGate asynchronously validates and produces a list of events.
 * The validate function and produce function implementations are passed
 * in by the user.  It is expected that validate return a Promise of
 * the validated event or throws an ValidationError, and that produce returns a
 * Promise of a produced event result or throws an Error.
 *
 * Once finished, events will be returned grouped by their status.
 *
 * If the mapToErrorEvent function is provided, it will be used to map
 * any failures from validation or other errors to error event objects.
 * mapToErrorEvent takes the original event object that caused the error
 * and an Error. It returns a new error event suitable for validating
 * and producing through the same validate and produce functions that the
 * EventGate instance uses for normal events. mapToErrorEvent will be called
 * for every encountered Error and event, and then the resulting event errors
 * will be processed using this EventGate instance.
 * If mapToErrorEvent returns null for a given error, no error event will be
 * produced for the error & event.
 *
 * Errors encountered during error event processing will not be handled
 * (but they will be logged).
 */
class EventGate {

    // Define function params for JSDoc
    /**
     * @name EventGate~validate
     * @method
     * @param {Object} event
     * @param {Object} context
     * @return {Promise<Object>}
     */

    /**
     * @name EventGate~produce
     * @method
     * @param {Object} event
     * @param {Object} context
     * @return {Promise<Object>}
     */

    /**
     * @name EventGate~eventRepr
     * @method
     * @param {Object} event
     * @param {Object} context
     * @return {string}
     */

    /**
     * @name EventGate~mapToErrorEvent
     * @method
     * @param {Error} error
     * @param {Object} event
     * @param {Object} context
     * @return {Object}
     */

    /**
     * @constructor
     * @param {Object} options
     * @param {EventGate~validate} options.validate
     *      (event, context) => event  (REQUIRED).
     * @param {EventGate~produce} options.produce
     *      (event, context) => result  (REQUIRED).
     * @param {EventGate~eventRepr} options.eventRepr
     *      (event, context) => string representation of event, used for logging
     * @param {Object} options.log
     *      A child bunyan logger will be created from this. If not provided,
     *      a new bunyan Logger will be created.
     * @param {EventGate~mapToErrorEvent} options.mapToErrorEvent
     *      (Error, event, context) => ErrorEvent. A function that creates error event
     *      objects from the offending original event that caused the error and the Error.
     *      If this is given, these error events will be produced asynchronously.
     *      If the map function returns null, no error event will be produced.
     */
    constructor(options = {}) {
        _.defaults(this, options, defaultOptions);

        if (_.isUndefined(this.validate)) {
            throw new Error('Cannot instantiate EventGate, must provide a validate function');
        }
        if (_.isUndefined(this.produce)) {
            throw new Error('Cannot instantiate EventGate, must provide a produce function');
        }
    }

    /**
     * Validates and produces event.
     *
     * @param {Object} event
     * @param {Object} context
     * @return {Promise<EventStatus>}
     */
    async _processEvent(event, context = {}) {
        this.log.trace({ event }, `Validating ${this.eventRepr(event)}...`);
        try {
            // validate() will validate event against the schema found at the
            // schema URL returned by schemaUrlExtractor, and then return the event.
            // The event may be modified; e.g. if the schema has a default for a field
            // but the event doesn't have it set. If the event failed validation,
            // an ValidationError will be thrown.
            const validEvent = await this.validate(event, context);
            // Now produce the validated event.
            this.log.trace(
                { event },
                `${this.eventRepr(event)} passed schema validation, producing...`
            );
            const produceResult = await this.produce(validEvent, context);
            // all went fine, return a success status
            return new EventStatus('success', produceResult, validEvent);
        } catch (err) {
            if (err instanceof ValidationError) {
                this.log.warn(
                    { err },
                    `${this.eventRepr(event)} failed schema validation.`
                );
                return new EventStatus('invalid', err, event);
            } else {
                this.log.error(
                    { err },
                    `${this.eventRepr(event)} encountered an error: ${err.message}`
                );
                return new EventStatus('error', err, event);
            }
        }
    }

    /**
     * Validates and produces events.
     *
     * @param {Array<Object>} events
     * @param {Object} context
     *      Additional context to provide to validate() and produce() functions.
     * @return {Object<Array>}
     *      of event validate/produce status keyed by status type.
     */
    process(events, context = {}) {
        // call _processEvent for every event.
        return P.map(events, (event) => this._processEvent(event, context))
        // Then group the array of EventStatus results to by result.status
        .then((results) => {
            // Group event validation and production results by status
            // Some could succeed and some fail.
            results = _.groupBy(results, (result) => result.status);

            // Make sure each possible result type is at least an empty array
            // to avoid undefined errors later. If there are no errors
            // results.error should not be undefined, it will be an empty array.
            _.each(EventStatus.STATUSES, (status) => {
                results[status] = results[status] || [];
            });

            // Convert any failed events to error events and produce them
            // if given mapToErrorEvent was configured.
            // This should be done in the background.
            const failedResults = results.invalid.concat(results.error);
            if (this.mapToErrorEvent && !_.isEmpty(failedResults)) {
                // Process each error event to validate and produce it.
                // NOTE: The results of this._processEvent will not be
                // inspected or returned.  If something goes wrong here
                // you should inspect the logs to find out about it.
                setTimeout(
                    () => {
                        // convert failed results into event errors and produce them.
                        const errorEvents = _.map(failedResults, (failedResult) => {
                            return this.mapToErrorEvent(
                                // context will be the error that caused the failure.
                                failedResult.context,
                                failedResult.event,
                                // Provide the event process context to mapToErrorEvent
                                // in case it wants to use it.
                                context
                            );
                        })
                        // Remove any empty elements; anything that was mapped to
                        // null will not be produced. This allows the implementation
                        // of mapToEventError to decide if a particular error event should
                        // be produced or not.
                        .filter((e) => !_.isEmpty(e));

                        this.log.info(
                            `${failedResults.length} failed, producing ` +
                            `${errorEvents.length} error events.`
                        );
                        // Provide the event process context to _processEvent for error event too
                        P.map(errorEvents, (errorEvent) => this._processEvent(errorEvent, context));
                    },
                    0
                );
            }

            return results;
        });
    }
}

module.exports = {
    EventGate,
    EventStatus
};
