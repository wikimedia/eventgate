'use strict';

const _        = require('lodash');
const EventInvalidError = require('../lib/validator').EventInvalidError;
const initUtils = require('../lib/eventbus-factory-utils');

/**
 * This module can be used as the value of app.conf.eventbus_init_module.  It exports
 * a function that given app.conf and a logger, returns an instantiated Eventbus instance
 * that will produce to Kafka, and a createEventError function for transforming
 * errors into events that can be produced to an error topic.
 */


/**
 * Returns a new createEventError function that uses conf.error_schema_uri, and conf.error_stream
 * To return an error event that conforms to the event error schema used by Wikimedia.
 *
 * TODO: fully implement this
 * @param {Object} conf
 * @return {function(Object, Object): Object}
 */
function createEventErrorFunction(conf) {
    return (error, event) => {
        const eventError = {
            meta: {
                schema_uri: conf.error_schema_uri,
                topic: conf.error_stream,
                // TODO:
                id: event.meta.id,
                uri: event.meta.uri,
                dt: event.meta.dt,
                domain: event.meta.domain
            },
            emitter_id: 'eventbus',  // TODO: ?
            raw_event: _.isString(event) ? event : JSON.stringify(event)
        };

        if (error instanceof EventInvalidError) {
            eventError.message = error.errorsText;
        } else if (_.isError(error)) {
            eventError.message = error.message;
            eventError.stack = error.stack;
        } else {
            eventError.message = error;
        }

        return eventError;
    };
}

// Return a function that instantiates eventbus and createEventError
// based on conf and logger.
module.exports = (conf, logger) => {
    return initUtils.createKafkaEventbus(
        conf,
        logger,
        // Use a custom wikimedia event
        createEventErrorFunction(conf)
    );
};
