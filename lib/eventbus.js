'use strict';

const _        = require('lodash');
const P        = require('bluebird');
const bunyan   = require('bunyan');

/**
 * EventInvalidError is expected to be thrown during event validation.
 */
const EventInvalidError = require('../lib/errors').EventInvalidError;

/**
 * Represents and Eventbus process status result.
 * Each event passed to Eventbus process() will map
 * to an final EventStatus.  If the status is a failure
 * this.context should contain the Error.
 */
class EventStatus {
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
     */
    toJSON() {
        let context;
        if (this.context instanceof Error && !(this.context instanceof EventInvalidError)) {
            // If context is an Error but not an EventInvalidError, then
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
    eventRepr: event => 'unknown',
    mapToErrorEvent: undefined,
    // This logger will be used if one is not provided to EventValidator contructor.
    log: bunyan.createLogger(
        { name: 'Eventbus', src: true, level: 'info' }
    )
};


/**
 * An Eventbus asynchronously validates and produces a list of events.
 * The validate function and produce function implementations are passed
 * in by the user.  It is expected that validate return a Promise of
 * the validated event or throws an EventInvalidError, and that produce returns a
 * Promise of a produced event result or throws an Error.
 *
 * Once finished, events will be returned grouped by their status.
 *
 * If the mapToErrorEvent function is provided, it will be used to map
 * any failures from validation or other errors to error event objects.
 * mapToErrorEvent takes the original event object that caused the error
 * and an Error. It returns a new error event suitable for validating
 * and producing through the same validate and produce functions that the
 * Eventbus instance uses for normal events. mapToErrorEvent will be called
 * for every encountered Error and event, and then the resulting event errors
 * will be produced. (If mapToErrorEvent returns null, no error event will be produced for
 * the error & event.)
 *
 * Errors encoutered during event error processing will not be handled. (TODO?)
 */
class Eventbus {
    /**
     * @param {Object} options
     * @param {function<(Object) => Object>} options.validate (event) => event  (REQUIRED).
     * @param {function<(Object) => Object>} options.produce (event) => result  (REQUIRED).
     * @param {function<(Object) => string>} options.eventRepr (event) => string representation of
     *                                       event, used for logging
     * @param {bunyan logger} options.log  A child bunyan logger will be
     *                        created from this. If not provided, a new bunyan Logger
     *                        will be created.
     * @param {function<(Object, Error) => Object} options.mapToErrorEvent A function that
     *                        creates error event objects from the offending original event
     *                        that caused the Errro and the Error. If this is given,
     *                        these error events will be produced asynchronously. If the
     *                        map function returns null, no error event will be produced.
     */
    constructor(options = {}) {
        _.defaults(this, options, defaultOptions);

        if (_.isUndefined(this.validate)) {
            throw new Error('Cannot instantiate Eventbus, must provide a validate function');
        }
        if (_.isUndefined(this.produce)) {
            throw new Error('Cannot instantiate Eventbus, must provide a produce function');
        }
    }

    /**
     * Validates and produces event.
     * @param {Object} event
     * @return {Promise<EventStatus>}
     */
    async _processEvent(event) {
        this.log.trace({ event }, `Validating ${this.eventRepr(event)}...`);

        try {
            // validate() will validate event against the schema found at the
            // schema URL returned by schemaUrlExtractor, and then return the event.
            // The event may be modified; e.g. if the schema has a default for a field
            // but the event doesn't have it set. If the event failed validation,
            // an EventInvalidError will be thrown.
            const validEvent = await this.validate(event);
            // Now produce the validated event.
            this.log.trace(
                { event },
                `${this.eventRepr(event)} passed schema validation, producing...`
            );
            const produceResult = await this.produce(validEvent);
            // all went fine, return a success status
            return new EventStatus('success', produceResult, validEvent);
        } catch (err) {
            if (err instanceof EventInvalidError) {
                this.log.debug(
                    { event, err },
                    `${this.eventRepr(event)} failed schema validation.`
                );
                return new EventStatus('invalid', err, event);
            } else {
                this.log.error(
                    { event, err },
                    `${this.eventRepr(event)} encountered an error: ${err.message}`
                );
                return new EventStatus('error', err, event);
            }
        }
    }

    /**
     * Validates and produces events.
     * @param {Array<Object>} events
     * @return {Object<Array>} of event validate/produce status keyed by status type.
     */
    process(events) {
        // call _processEvent for every event.
        return P.map(events, event => this._processEvent(event))
        // Then group the array of EventStatus results to by result.status
        .then((results) => {
            // Group event validation and production results by status
            // Some could succeed and some fail.
            results = _.groupBy(results, result => result.status);

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
                // TODO should we ignore results like this?  They will be logged...
                // TODO is setTimeout(..., 0) necessary here?  Not sure.  Could we just
                // do P.map() to make this background async?
                setTimeout(
                    () => {
                        // convert failed results into event errors and produce them.
                        const errorEvents = _.map(failedResults, (failedResult) => {
                            return this.mapToErrorEvent(
                                failedResult.event,
                                // context will be the error that caused the failure.
                                failedResult.context
                            );
                        })
                        // Remove any empty elements; anything that was mapped to
                        // null will not be produced. This allows the implementation
                        // of mapToEventError to decide if a particular error event should
                        // be produced or not.
                        .filter(e => !_.isEmpty(e));

                        this.log.info(
                            `${failedResults.length} failed, producing ` +
                            `${errorEvents.length} error events.`
                        );
                        P.map(errorEvents, errorEvent => this._processEvent(errorEvent));
                    },
                    0
                );
            }

            return results;
        });
    }
}


module.exports = {
    Eventbus,
    EventStatus
};
