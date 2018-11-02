'use strict';

const P = require('bluebird');
const _ = require('lodash');

const {
    urlGetObject,
    objectGet
} = require('../../lib/event-util');

const kafka = require('../../lib/kafka');
const Eventbus = require('../../lib/eventbus.js').Eventbus;

const {
    makeValidate,
    makeProduce,
    makeEventRepr,
    makeExtractSchemaUri,
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
 * Returns a new mapToErrorEvent function that uses options.error_schema_uri
 * and options.error_stream to return an error event that conforms to the
 * error event schema used by Wikimedia.
 *
 * TODO: fully implement this
 * @param {Object} options
 * @return {function(Object, Object): Object}
 */
function makeMapToErrorEvent(options) {
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

        // Only produce error events for EventInvalidErrors.
        if (error instanceof EventInvalidError) {
            eventError.message = error.errorsText;
        } else {
            // Returning null will cause this particular error event
            // to not be produced at all.
            return null;
        }

        return eventError;
    };
}


class UnauthorizedSchemaForStreamError extends Error {}

// TODO
async function makeEnsureSchemaAllowedInStream(options) {
    const streamConfig = await urlGetObject(options.stream_config_uri);

    // Use the same extractSchemaUri function that the eventValidator will use.
    // TODO: we could get this from the EventValidator instance itself.
    const extractSchemaUri = makeExtractSchemaUri(options);

    return (event) => {
        const schemaName = extractSchemaUri(event);

        // TODO: this will throw PropertyNotFoundError, hmmm if no stream_field in event.
        // HMMMM...stream really should be part of API.
        const streamName =  objectGet(event, options.stream_field);
        const streamConfigForEvent = _.get(streamConfig, streamName);

        if (_.isUndefined(streamConfigForEvent)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema ${schemaName} is not allowed in stream ${streamName}; ` +
                `${streamName} is not a configured stream.`
            );
        }

        const allowedSchemaName = _.get(
            streamConfigForEvent, options.schema_uri_field, defaultOptions.schema_uri_field
        );

        // TODO: make this check smarter.
        if (!schemaName.includes(allowedSchemaName)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema ${schemaName} is not allowed in stream ${streamName}; ` +
                `must be ${allowedSchemaName}`
            );
        }

        return true;
    };
}

// TODO
async function makeWikimediaValidate(options, logger) {
    // Use the default validate function.
    const validateEvent = makeValidate(options, logger);
    // const eventValidator = eventValidatorFactory(options, logger);


    const ensureSchemaAllowedInStream = await makeEnsureSchemaAllowedInStream(options);
    return (event) => {
        // First ensure that this event schema is allowed in the destination stream.
        ensureSchemaAllowedInStream(event);
        // Then validate the event against its schema.
        return validateEvent(event);
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
            mapToErrorEvent: makeMapToErrorEvent(options)
        });
    });
}


module.exports = {
    factory: wikimediaEventbusFactory,
    makeValidate,
    makeEnsureSchemaAllowedInStream,
    UnauthorizedSchemaForStreamError,
    makeMapToErrorEvent
};
