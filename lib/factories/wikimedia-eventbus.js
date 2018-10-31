'use strict';

const P = require('bluebird');
const _                      = require('lodash');

const {
    urlGetObject,
    objectGet
} = require('../../lib/event-utils');

const kafka = require('../../lib/kafka');
const Eventbus = require('../../lib/eventbus.js').Eventbus;

const {
    makeValidate,
    makeProduce,
    makeEventRepr,
    defaultOptions
} = require('../../lib/factories/default-eventbus');

const EventInvalidError      = require('../../lib/errors').EventInvalidError;


/**
 * This module can be used as the value of app.options.eventbus_factory_module.  It exports
 * a factory function that given options and a logger, returns an instantiated Eventbus instance
 * that will produce to Kafka, and a mapToEventError function for transforming
 * errors into events that can be produced to an error topic.
 */


/**
 * Returns a new mapToErrorEvent function that uses options.error_schema_uri, and options.error_stream
 * To return an error event that conforms to the event error schema used by Wikimedia.
 *
 * TODO: fully implement this
 * @param {Object} options
 * @return {function(Object, Object): Object}
 */
function makeMapToEventError(options) {
    return (event, error) => {
        const eventError = {
            '$schema': options.error_schema_uri,
            meta: {
                topic: options.error_stream,
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


class UnauthorizedSchemaForStreamError extends Error {}

// TODO
function ensureSchemaAllowedInStreamFromConf(options) {
    return urlGetObject(options.stream_config_uri).then((streamConfig) => {
        return (event) => {
            const streamName =  objectGet(event, options.stream_field);
            const thisStreamConfig = objectGet(streamConfig, streamName);
            const allowedSchemaName = objectGet(thisStreamConfig, '$schema');
            const schemaName = objectGet(event, options.schema_uri_field);

            // TODO: make this check smarter.
            if (!schemaName.includes(allowedSchemaName)) {
                throw new UnauthorizedSchemaForStreamError(
                    `Schema ${schemaName} is not allowed in stream ${streamName}; ` +
                    `must be ${allowedSchemaName}`
                );
            }

            return true;
        };
    });
}

// TODO
async function makeWikimediaValidate(options, logger) {
    // This Eventbus instance will use
    // the eventValidator's validate function to validate
    // incoming events.
    const validate = makeValidate(options, logger);

    const ensureSchemaAllowedInStream = await ensureSchemaAllowedInStreamFromConf(options);
    return (event) => {
        ensureSchemaAllowedInStream(event);
        return validate(event);
    };
}

function wikimediaEventbusFactory(options, logger) {
    _.defaults(options, defaultOptions);

    const validatePromise = makeWikimediaValidate(options, logger);

    // This Eventbus instance will use a kafka producer
    const producePromise = kafka.createKafkaProducer(
        options.kafka.options,
        options.kafka.topic_conf
    )
    .then(kafkaProducer => makeProduce(options, kafkaProducer));

    return P.all([validatePromise, producePromise])
    .spread((validate, produce) => {
        return new Eventbus({
            validate,
            produce,
            eventRepr: makeEventRepr(options),
            log: logger,
            mapToEventError: makeMapToEventError(options)
        });
    });
}



module.exports = {
    factory: wikimediaEventbusFactory,
    makeValidate,
    ensureSchemaAllowedInStreamFromConf,
    UnauthorizedSchemaForStreamError,
    makeMapToEventError
};
