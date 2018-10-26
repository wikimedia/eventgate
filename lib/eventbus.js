'use strict';

const _        = require('lodash');
const P        = require('bluebird');
const bunyan          = require('bunyan');

// TODO this error should be generic!  Should not be implementation specific.
const EventInvalidError = require('../lib/EventValidator').EventInvalidError;


/**
 * Represents and Eventbus process status result.
 * Each event passed to Eventbus process() will map
 * to an final EventStatus.  If the status is a failure
 * this.context should contain the error.
 */
class EventStatus {
    constructor(status, context, event) {
        this.status = status;
        this.context = context;
        this.event = event;
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
 * will be produced.
 * Errors encoutered during event error processing will not be handled. (TODO?)
 */
class Eventbus {
    /**
     * @param {function<(Object) => Object>} validate (event) => event
     * @param {function<(Object) => Object>} produce (event) => result
     * @param {function<(Object) => string>} eventRepr (event) => string representation of
     *                                       event, used for logging
     * @param {bunyan logger} logger  A child bunyan logger will be
     *                        created from this. If not provided, a new bunyan Logger
     *                        will be created.
     * @param {function<(Object, Error) => Object} mapToErrorEvent A function that
     *                        creates error event objects from the offending original event
     *                        that caused the Errro and the Error. If this is given,
     *                        these error events will be produced asynchronously.
     */
    constructor(
        // validates and returns Promise of event, or throws an error
        validate,
        // produces event, returns Promise of event produce status or throws an error
        produce,
        // Returns a string suitable for representation of an event.
        // This is mainly used for logging.
        eventRepr = (event) => { return 'unknown'; },
        logger = undefined,
        mapToErrorEvent = undefined
    ) {
        this.validate = validate;
        this.produce = produce;
        this.eventRepr = eventRepr;
        this.mapToErrorEvent = mapToErrorEvent;

        if (_.isUndefined(logger)) {
            this.log = bunyan.createLogger(
                { name: 'Eventbus', src: true, level: 'info' }
            );
        } else {
            this.log = logger.child();
        }
    }

    /**
     * Validates and produces event.
     * @param {Object} event
     * @return {Promise<Object>} event produce status
     */
    _processEvent(event) {
        this.log.trace({ event }, `Validating ${this.eventRepr(event)}...`);

        // validate() will validate event against the schema found at the
        // schema URL returned by schemaUrlExtractor, and then return the event.
        // The event may be modified; e.g. if the schema has a default for a field
        // but the event doesn't have it set. If the event failed validation,
        // an EventInvalidError will be thrown.
        return this.validate(event)
        // If we are in this block, the event is valid, produce it.
        .then((event) => {
            this.log.trace(
                { event },
                `${this.eventRepr(event)} passed schema validation, producing...`
            );
            return this.produce(event);
        })
        .then((produceResult) => {
            return new EventStatus('success', produceResult, event);
        })
        // TODO is there a way to make the invalid
        // detection from this.validate more generic?
        // Right now Eventbus doesn't know anything about the EventValidator
        // class, which is the one that knows how to throw EventInvalidError.
        // Can we decouple this?
        .catch(EventInvalidError, (err) => {
            this.log.debug(
                { event, errors: err.errorsText },
                `${this.eventRepr(event)} failed schema validation: ${err.message}`
            );
            return new EventStatus('invalid', err, event);
        })
        .catch((err) => {
            this.log.error(
                { event },
                `${this.eventRepr(event)} encountered an error: ${err.message}`
            );
            return new EventStatus('error', err, event);
        });
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
            // This should be done in the background
            // TODO: if we encounter Kafka errors...what then?
            const failedResults = results.invalid.concat(results.error);
            if (this.mapToErrorEvent && !_.isEmpty(failedResults)) {

                // Process each eventError to validate and produce it.
                // TODO should we ignore results like this?  They will be logged...
                // TODO is setTimeout(..., 0) necessary here?  Not sure.  Could we just
                // do P.map() to make this background async?
                setTimeout(
                    () => {
                        this.log.info(`Producing ${failedResults.length} failed event errors.`);

                        // convert failed results into event errors and produce them.
                        const eventErrors = _.map(failedResults, (failedResult) => {
                            return this.mapToErrorEvent(
                                failedResult.event,
                                // context will be the error that caused the failure.
                                failedResult.context
                            );
                        });
                        P.map(eventErrors, eventError => this._processEvent(eventError));
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
