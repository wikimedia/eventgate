'use strict';

const _ = require('lodash');

const {
    urlGetObject,
    objectGet
} = require('../event-util');

const kafka = require('../kafka');
const Eventbus = require('../eventbus.js').Eventbus;

// We'll use the validator and schema_uri implementations that
// default Eventbus uses, but most of the Wikimedia specific produce
// related funciton implemenations are custom and will be defined in this file.
const {
    makeValidate,
    makeExtractSchemaUri,
} = require('../factories/default-eventbus');

const EventInvalidError      = require('../error').EventInvalidError;


/**
 * This module can be used as the value of app.options.eventbus_factory_module.  It exports
 * a factory function that given options and a logger, returns an instantiated Eventbus instance
 * that will produce to Kafka, and a mapToEventError function for transforming
 * errors into events that can be produced to an error topic.
 *
 * This file contains various functions for configuring and creating the main 'wikimedia'
 * Eventbus instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventBus instance.
 *
 * This file uses some functions exported by default-eventbus module but also
 * creates some new more Wikimedia specific functions.
 *
 * The following keys are used in the options argument in functions here.
 *
 * - schema_uri_field
 *      The dotted object path to extract a schema_uri from an event.
 *      Default: $schema
 *
 * - schema_base_uri
 *      A base uri to prepend to values extracted from event schema_uri_fields
 *      Default: undefined
 *
 * - schema_file_extension
 *      A file extension to append to the extracted schema_uri_field if its
 *      URI doesn't already have one.
 *      Default: undefined
 *
 * - stream_field
 *      The dotted object path to the value to use for the topic/stream.
 *      If this is not given, the scheam_uri_field will be used to construct
 *      a sanitized stream name.
 *      Default: undefined
 *
 * - topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used for the Kafka topic the event will be produced to.
 *      Default: undefined
 *
 * - id_field
 *      This field will be used as the event's 'id' in log messages
 *      Default: undefined
 *
 * - kafka.conf
 *      node-rdkafka KafkaProducer configuration
 *
 * - kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 */


const defaultOptions = {
    schema_uri_field:       '$schema',
    schema_base_uri:        undefined,
    schema_file_extension:  undefined,
    stream_field:           undefined,
    topic_prefix:           undefined,
    id_field:               undefined,
    kafka: {
        conf: {
            'metadata.broker.list': 'localhost:9092'
        },
        topic_conf: {}
    },
};

/**
 * Returns a new mapToErrorEvent function that uses options.error_schema_uri
 * and options.error_stream to return an error event that conforms to the
 * error event schema used by Wikimedia.
 *
 * TODO: fully implement this
 * @param {Object} options
 * @return {function(Object, Object, Object): Object}
 */
function makeMapToErrorEvent(options) {
    return (error, event, context = {}) => {
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

    const ensureSchemaAllowedInStream = await makeEnsureSchemaAllowedInStream(options);
    return (event) => {
        // First ensure that this event schema is allowed in the destination stream.
        ensureSchemaAllowedInStream(event);
        // Then validate the event against its schema.
        return validateEvent(event);
    };
}

/**
 * All wikimedia events should have stream_field set.  The function
 * created by this function returns the value extracted from event at stream_field.
 * @param {Object} options
 * @param {stirng} options.stream_field
 * @return {function(Object, Object): string}
 */
function makeExtractStreamName(options) {
    return (event, context = {}) => {
        // TODO: Should we throw a custom error?
        return objectGet(event, options.stream_field);
    };
}

/**
 * Creates a function that extracts a topic (and potentially adds a prefix)
 * using options.stream_field and options.topic_prefix.
 * @param {Object} options
 * @param {stirng} options.stream_field
 *      Used to extract the event's destination stream name.
 * @param {stirng} options.topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used as the topic in Kafka.
 * @return {function(Object, Object): string}
 */
function makeExtractTopic(options) {
    const extractStreamName = makeExtractStreamName(options);
    return (event, context = {}) => {
        const streamName = extractStreamName(event);
        return options.topic_prefix ?  options.topic_prefix + streamName : streamName;
    };
}

/**
 * Creates a function that returns a string representation of an event useful for logging.
 * @param {Object} options
 * @param {string} options.id_field
 *      Used to extract the event's 'id'.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {stirng} options.stream_field
 *      Used to extract the event's destination stream name.
 * @return {function(Object, Object): string}
 */
function makeEventRepr(options) {
    const extractSchemaUri = makeExtractSchemaUri(options);
    const extractStreamName = makeExtractStreamName(options);

    return (event, context = {}) => {
        let eventId = _.get(event, options.id_field);
        // formatting for repr string if no event id.
        eventId = eventId ? `${eventId} ` : '';
        const schemaUri = extractSchemaUri(event, context);
        const streamName = extractStreamName(event, context);

        return `Event ${eventId}with schema ${schemaUri} destined to ${streamName}`;
    };
}

/**
 * Creates a function that returns a Kafka produce function
 * suitable for passing to Eventbus as the produce function argument.
 * This conditionally uses either a GuarunteedProducer or a HastyProducer
 * depending on the value of the event context.req.query.hasty.
 * @param {Object} options
 * @param {stirng} options.stream_field
 *      Used to extract the event's destination stream name.
 * @param {stirng} options.topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used as the topic in Kafka.
 * @param {string} options.key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 * @param {string} options.partition_field
 *      If given, the event's 'partition' will be extracted from the event at this
 *      dotted object path.
 * @param {KafkaProducer} guarunteedProducer
 *      Connected node-rdkafka Producer.
 * @param {KafkaProducer} hastyProducer
 *      Connected node-rdkafka Producer that sends events non guarunteed, aka hasty.
 *      This is optional, and will only be used if context.req.query.hasty is set to true.
 * @return {function(Object, Object): Promise<Object>} (event, context) => Promise<event>
 */
function makeProduce(options, guarunteedProducer, hastyProducer) {
    // Create new functions that use static optionsiguration
    // to extract Kafka produce() params from an event.
    const extractTopic = makeExtractTopic(options);

    // Return a new function that takes a single event argument for produce.
    return (event, context = {}) => {
        const topic = extractTopic(event);
        const serializedEvent = Buffer.from(JSON.stringify(event));

        // Use hasty non guarunteed producer if this event was submitted
        // using via HTTP with the ?hasty query parameter set to true.
        if (hastyProducer && _.get(context, 'req.query.hasty', false)) {
            return hastyProducer.produce(topic, undefined, serializedEvent, undefined);
        } else {
            return guarunteedProducer.produce(topic, undefined, serializedEvent, undefined);
        }
    };
}


/**
 * Returns a Promise of an instantiated Eventbus that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  This
 * instance does not do any producing of error events.
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {string} options.id_field
 *      Used to extract the event's 'id'.
 * @param {stirng} options.stream_field
 *      Used to extract the event's destination stream name.
 * @param {stirng} options.topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used as the topic in Kafka.
 * @param {string} options.id_field
 *      This field will be used as the event's 'id' in log messages
 * @param {Object} options.kafka
 * @param {Object} options.kafka.options
 *      node-rdkafka KafkaProducer optionsiguration
 * @param {Object} options.kafka.topic_options
 *      node-rdkafka KafkaProducer topic optionsiguration
 * @param {bunyan logger} logger
 * @return {Promise<EventBus>}
 */
async function wikimediaEventbusFactory(options, logger) {
    _.defaults(options, defaultOptions);

    const validate = await makeWikimediaValidate(options, logger);

    // Create both a GuarunteedProducer and a HastyProducer.
    // Which one is used during produce() is determined by the
    // req.query.hasty parameter.
    const guarunteedProducer = await kafka.GuaranteedProducer.factory(
        options.kafka.options,
        options.kafka.topic_conf
    );
    const hastyProducer = await kafka.HastyProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );

    const produce = makeProduce(options, guarunteedProducer, hastyProducer);

    return new Eventbus({
        validate,
        produce,
        eventRepr: makeEventRepr(options),
        log: logger,
        mapToErrorEvent: makeMapToErrorEvent(options)
    });
}


module.exports = {
    factory: wikimediaEventbusFactory,
    makeValidate,
    makeEnsureSchemaAllowedInStream,
    UnauthorizedSchemaForStreamError,
    makeMapToErrorEvent
};
