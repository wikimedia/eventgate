'use strict';

const _        = require('lodash');
const EventValidator = require('../../lib/EventValidator');
const kafka = require('../../lib/kafka');
const Eventbus = require('../../lib/eventbus.js').Eventbus;

const {
    EventSchemaUriMissingError,
    PropertyNotFoundError
} = require('../../lib/errors');

const {
    objectGet,
    resolveUri,
} = require('../../lib/event-utils');


/**
 * This file contains various functions for optionsiguring and creating a 'default' EventBus
 * instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventBus instance.
 *
 * You can and should make new Eventbus factory modules that themselves return
 * an custom Eventbus factory.  This module also exports the individual functions
 * used to create this default Eventbus, in case you want to plug some of them
 * into your own custom Eventbus instance.
 *
 * The following keys are used in the options argument by functions in this file:
 *
 * - schema_uri_field
 *      The dotted object path to extract a schema_uri from an event.
 *
 * - schema_base_uri
 *      A base uri to prepend to values extracted from event schema_uri_fields
 *
 * - schema_file_extension
 *      A file extension to append to the extracted schema_uri_field if its
 *      URI doesn't already have one.
 *
 * - stream_field
 *      The dotted object path to the value to use for the topic/stream
 *      TODO: stream_field or topic_field?
 *      TODO: this probably shouldn't be in events at all.  IT should be part of the API
 *
 * - topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used for the event topic.
 *
 * - key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 *
 *  - partition_field
 *      If given, the event's 'partition' will be extracted from the event at this dotted
 *      object path.
 *
 * - id_field
 *      This field will be used as the event's 'id' in log messages
 *
 * - kafka.options
 *      node-rdkafka KafkaProducer optionsiguration
 *
 * - kafka.topic_options
 *      node-rdkafka KafkaProducer topic optionsiguration
 */


const defaultOptions = {
    schema_uri_field:       '$schema',
    schema_base_uri:        undefined,
    schema_file_extension:  undefined,
    stream_field:           undefined,
    topic_prefix:           undefined,
    key_field:              undefined,
    partition_field:        undefined,
    id_field:               undefined,
    kafka: {
        options: {
            'metadata.broker.list': 'localhost:9092'
        },
        topic_options: {}
    },
};

/**
 * Returns a function that extracts the event's schema URI.
 * @param {Object} options 
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @return {function(Object): string}
 */
function makeExtractSchemaUri(options) {
    const schemaUriField = _.get(options, 'schema_uri_field', defaultOptions.schema_uri_field);
    return (event) => {
        try {
            return objectGet(event, _.get(options, 'schema_uri_field'));
        } catch (err) {
            // Wrap PropertyNotFoundError in a new specific Error about missing Schema URI.
            if (err instanceof PropertyNotFoundError) {
                throw new EventSchemaUriMissingError(
                    'Event schema URI cannot be extracted. ' + 
                    `Event must have a '${schemaUriField}' property`
                );
            }
        }
    };
}

/**
 * Returns a function that given a URI, will resolve it using
 * options.schema_base_uri and options.schema_file_extension.
 * See also the event-utils resolveUri function.
 * @param {Object} options
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @returns {function(string): string} 
 */
function makeResolveSchemaUri(options) {
    return uri => resolveUri(
        uri, options.schema_base_uri, options.schema_file_extension
    );
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
 * @return {function(Object): string}
 */
function makeExtractTopic(options) {
    return (event) => {
        const streamName = objectGet(event, options.stream_field);
        return options.topic_prefix ?  options.topic_prefix + streamName : streamName;
    };
}

/**
 * Creates a function that extracts a Kafka key, uses options.key_field.
 * If key_field is not set, this will return undefined instead of a new function.
 * @param {Object} options
 * @param {string} options.key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 * @return {function(Object): *= }
 */
function makeExtractKey(options = {}) {
    if (_.isUndefined(options.key_field)) {
        return undefined;
    } else {
        return event => objectGet(event, options.key_field);
    }
}

/**
 * Creates a function that extracts a kafka partition, useus options.partition_field.
 * If partition_field is not set, this will return undefined instead of a new function.
 * @param {Object} options
 * @param {string} options.partition_field
 *      If given, the event's 'partition' will be extracted from the event at this
 *      dotted object path.
 * @return {function(Object): integer}
 */
function makeExtractPartition(options = {}) {
    if (_.isUndefined(options.partition_field)) {
        return undefined;
    } else {
        return event => _.get(event, options.partition_field);
    }
}


/**
 * Creates a function that returns a string representation of an event.
 * @param {Object} options
 * @param {string} options.id_field
 *      Used to extract the event's 'id'.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {stirng} options.stream_field
 *      Used to extract the event's destination stream name.
 * @return {function(Object): string}
 */
function makeEventRepr(options) {
    return (event) => {
        let eventId = _.get(event, options.id_field);
        // formatting for repr string if no event id.
        eventId = eventId ? `${eventId} ` : '';
        const schemaUri = _.get(event, options.schema_uri_field, 'unknown');
        const streamName = _.get(event, options.stream_field, 'unknown');

        return `Event ${eventId}with schema ${schemaUri} destined to ${streamName}`;
    };
}


function eventValidatorFactory(options, logger) {
    return new EventValidator({
        extractSchemaUri: makeExtractSchemaUri(options),
        resolveSchemaUri: makeResolveSchemaUri(options),
        log: logger
    });
}

/**
 * Creates a new schema URI based validate(event) function.
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {bunyan logger} logger
 * @return {function(Object): Promise<Object>}
 */
function makeValidate(options, logger) {
    const eventValidator = eventValidatorFactory(options, logger);
    return eventValidator.validate.bind(eventValidator);
}

/**
 * Creates a function that returns a connected Kafka Producer's produce function,
 * suitable for passing to Eventbus as the produce function argument.
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
 * @param {KafkaProducer} kafkaProducer
 *      Connected node-rdkafka Producer.
 * @return {function(Object): Promise<Object>}
 */
function makeProduce(options, kafkaProducer) {
    // Create new functions that use static optionsiguration
    // to extract Kafka produce() params from an event.
    const extractTopic      = makeExtractTopic(options);
    const extractPartition  = makeExtractPartition(options);
    const extractKey        = makeExtractKey(options);

    // Return a new function that takes a single event argument for produce.
    return (event) => {
        const topic = extractTopic(event);
        const partition = extractPartition ? extractPartition(event) : undefined;
        const key = extractKey ? extractKey(event) : undefined;
        const serializedEvent = Buffer.from(JSON.stringify(event));

        return kafkaProducer.produce(topic, partition, serializedEvent, key);
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
 * @param {string} options.key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 * @param {string} options.partition_field
 *      If given, the event's 'partition' will be extracted from the event at this
 *      dotted object path.
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
async function eventbusFactory(options, logger) {
    // Set default options
    _.defaults(options, defaultOptions);

    const kafkaProducer = await kafka.createKafkaProducer(
        options.kafka.options,
        options.kafka.topic_options
    );

    return new Eventbus({
        // This Eventbus instance will use
        // the EventValidator's validate function to validate
        // incoming events.
        validate:   makeValidate(options, logger),
        // This Eventbus instance will use a kafka producer
        produce:    makeProduce(options, kafkaProducer),
        eventRepr:  makeEventRepr(options),
        log:        logger
    });
}

module.exports = {
    factory: eventbusFactory,
    defaultOptions,
    makeValidate,
    makeProduce,
    eventValidatorFactory,
    makeExtractSchemaUri,
    makeResolveSchemaUri,
    makeEventRepr,
    makeExtractTopic,
    makeExtractKey,
    makeExtractPartition
};
