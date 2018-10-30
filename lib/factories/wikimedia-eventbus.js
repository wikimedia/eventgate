'use strict';

const P = require('bluebird');
const _                      = require('lodash');

const kafka = require('../../lib/kafka');

const eventValidate = require('../../lib/factories/event-validate');
const kafkaProduce  = require('../../lib/factories/kafka-produce');
const {
    createEventReprFunction,
    setConfDefaults
} = require('../../lib/factories/default-eventbus');

const EventInvalidError      = require('../../lib/errors').EventInvalidError;
const Eventbus = require('../../lib/eventbus.js').Eventbus;
const {
    urlGetObject,
    objectGet
} = require('../../lib/event-utils');

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
function createMapToErrorEvent(conf) {
    return (event, error) => {
        const eventError = {
            '$schema': conf.error_schema_uri,
            meta: {
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


class UnauthorizedSchemaForStreamError extends Error {}

function createValidateSchemaForStream(conf) {
    return urlGetObject(conf.stream_config_uri).then((streamConfig) => {
        return (event) => {
            const streamName =  objectGet(event, conf.stream_field);
            const thisStreamConfig = objectGet(streamConfig, streamName);
            const allowedSchemaName = objectGet(thisStreamConfig, '$schema');
            const schemaName = objectGet(event, conf.schema_uri_field);

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


async function createStreamConfigEventValidator(conf, logger) {
    // This Eventbus instance will use
    // the eventValidator's validate function to validate
    // incoming events.
    const validate = eventValidate.factory(conf, logger);

    const validateSchemaForStream = await createValidateSchemaForStream(conf);
    return (event) => {
        validateSchemaForStream(event);
        return validate(event);
    };
}

function createFromConf(conf, logger) {
    conf = setConfDefaults(conf);

    const validatePromise = createStreamConfigEventValidator(conf, logger);

    // This Eventbus instance will use a kafka producer
    const producePromise = kafka.createKafkaProducer(
        conf.kafka.conf,
        conf.kafka.topic_conf
    )
    .then(kafkaProducer => kafkaProduce.factory(conf, kafkaProducer));

    return P.all([validatePromise, producePromise])
    .spread((validate, produce) => {
        return new Eventbus({
            validate,
            produce,
            eventRepr:createEventReprFunction(conf),
            log: logger,
            mapToEventError: createMapToErrorEvent(conf)
        });
    });
}


// Return a function that instantiates eventbus and createEventError
// based on conf and logger.
module.exports = {
    factory: createFromConf
};
