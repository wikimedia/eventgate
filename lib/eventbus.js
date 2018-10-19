'use strict';

const _        = require('lodash');
const P        = require('bluebird');
const bunyan          = require('bunyan');

const EventInvalidError = require('../lib/validator').EventInvalidError;


class EventStatus {
    constructor(status, context, event) {
        this.status = status;
        this.context = context;
        this.event = event;
    }

    /**
     * static 'enum' constant for possible status types.
     */
    static STATUSES() {
        return [
            'success',
            'error',
            'invalid'
        ];
    }
}

/**
 * An EventBus asynchronously validates and produces a list of events.
 * The validate function and produce function implementations are passed
 * in by the user.  It is expected that validate return a Promse of
 * the validated event or throws an EventInvalidError, and that produce returns a
 * Promise of a produced event result or throws an Error.
 *
 * Once finished, events will be returned grouped by their status.
 */
class EventBus {
    /**
     * @param {function<(Object) => Object>} validate (event) => event
     * @param {function<(Object) => Object>} produce (event) => result
     * @param {function<(Object) => string>} eventRepr (event) => string representation of
     *                                       event, used for logging
     * @param {bunyan logger} logger  A child bunyan logger will be
     *                        created from this. If not provided, a new bunyan Logger
     *                        will be created.
     */
    constructor(
        // validates and returns Promise of event, or throws an error
        validate = (event) => { return event; },
        // produces event, returns Promise of event produce status or throws an error
        produce = (event) => { return event; },
        // Returns a string suitable for representation of an event.
        // This is mainly used for logging.
        eventRepr = (event) => { return 'unknown'; },
        logger = undefined
    ) {
        this.validate = validate;
        this.produce = produce;
        this.eventRepr = eventRepr;

        if (_.isUndefined(logger)) {
            this.log = bunyan.createLogger(
                { name: 'EventBus', src: true, level: 'info' }
            );
        } else {
            this.log = logger.child();
        }
    }

    /**
     * Validates and produces event.
     * @param {Object} event
     * @return {Promise<Object>} event produce status
     * @throws {Error|EventInvalidError}
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
            });
    }

    /**
     * Validates and produces events.
     * @param {Array<Object>} events
     * @return {Object<Array>} of event validate/produce status keyed by status type.
     */
    process(events) {
        // Make sure events is an array.  If it isn't, expect that it is a single event.
        events = _.isArray(events) ? events : [events];

        return P.map(events, (event) => {
            return this._processEvent(event)
            // TODO: turn result objects into class???
                .then((result) => {
                    return new EventStatus('success', result, event);
                })
                // TODO is there a way to make the invalid
                // detection from this.validate more generic?
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
        })
        .then((results) => {
            // Group event validation and production results by status
            // Some could succeed and some fail.
            results =  _.groupBy(results, (result) => {
                return result.status;
            });

            // Make sure each possible result type as at least an empty array
            // to avoid undefined errors later. E.g. if there are no errors,
            // results.error will not be undefined, it will be an empty array.
            _.each(EventStatus.STATUSES(), (status) => {
                if (!_.has(results, status)) {
                    results[status] = [];
                }
            });

            return results;
        });
    }
}


module.exports = {
    EventBus,
    EventStatus
};
