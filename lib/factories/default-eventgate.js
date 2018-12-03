'use strict';

const _              = require('lodash');
const EventValidator = require('../EventValidator');
const kafka          = require('../kafka');
const EventGate       = require('../eventgate.js').EventGate;

const {
    EventSchemaUriMissingError
} = require('../error');

const {
    objectGet,
    resolveUri,
} = require('../event-util');


/**
 * This file contains various functions for optionsiguring and creating a 'default' EventGate
 * instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventGate instance.
 *
 * You can and should make new EventGate factory modules that themselves return
 * an custom EventGate factory.  This module also exports the individual functions
 * used to create this default EventGate, in case you want to plug some of them
 * into your own custom EventGate instance.
 *
 * The following keys are used in the options argument by functions in this file:
 *
 * - schema_uri_field
 *      The dotted object path to extract a schema_uri from an event.
 *      If this is an array, the event will be searched for a field
 *      named by each element.  The first match will be used.
 *      This allows you to support events that might have
 *      Their schema_uris at different locations.
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
    kafka: {
        conf: {
            'metadata.broker.list': 'localhost:9092'
        },
        topic_conf: {}
    },
};

/**
 * Returns a function that extracts the event's schema URI.
 * @param {Object} options
 * @param {string|Array<string>} options.schema_uri_field
 *      Field(s) used to extract the schema_uri from an event.
 *      If this is an array, the event will be searched for a field
 *      named by each element.  The first match will be used.
 *      This allows you to support events that might have
 *      Their schema_uris at different locations.
 * @return {function(Object, Object): string}
 */
function makeExtractSchemaUri(options) {
    let schemaUriFields = _.get(options, 'schema_uri_field', defaultOptions.schema_uri_field);

    if (!_.isArray(schemaUriFields)) {
        schemaUriFields = [schemaUriFields];
    }

    return (event, context = {}) => {
        const schemaUriField = schemaUriFields.find(f => _.has(event, f));
        if (!schemaUriField) {
            throw new EventSchemaUriMissingError(
                'Event schema URI cannot be extracted. ' +
                `Event must have a field named one of '${schemaUriFields}'.`
            );
        }

        return objectGet(event, schemaUriField);
    };
}

/**
 * If options.stream_field is configured, then it will be used to extract
 * the event's destination stream name.  Otherwise, it is assumed
 * that the event's sanitized schema URI should be used as the stream name.
 * The schema URI returned by the function returned by makeExtractSchemaUri
 * with options.schema_uri_field will be used to extract the schema URI,
 * and then the schema URI will be sanitized to remove potential bad characters.
 * Any character that does not match [A-Za-z0-9_.-] will be replaced with
 * an underscore.
 * @param {Object} options
 * @param {stirng} options.stream_field
 *      If given, used to extract the event's destination stream name.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI to use as a sanitized stream name.
 *      This is only used if options.stream_field is not given.
 * @return {function(Object, Object): string}
 */
function makeExtractStreamName(options) {
    // If no stream_field in event, fallback to sanitized schema uri
    if (_.isUndefined(options.stream_field)) {
        const extractSchemaUri = makeExtractSchemaUri(options);
        const badCharsRegex = new RegExp('[^A-Za-z0-9_.-]', 'g');
        const replacementChar = '_';
        return (event, context = {}) => {
            const schemaUri = extractSchemaUri(event);
            return schemaUri.replace(badCharsRegex, replacementChar);
        };
    } else {
        return (event, context = {}) => {
            return objectGet(event, options.stream_field);
        };
    }
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
    /**
     * Given a URI, will resolve it using
     * options.schema_base_uri and options.schema_file_extension.
     * See also the event-utils resolveUri function.
     * @param {string} uri
     * @return {function(string): string}
     */
    function resolveSchemaUri(uri) {
        return resolveUri(uri, options.schema_base_uri, options.schema_file_extension);
    }

    const eventValidator = new EventValidator({
        extractSchemaUri: makeExtractSchemaUri(options),
        resolveSchemaUri,
        log: logger
    });
    return eventValidator.validate.bind(eventValidator);
}

/**
 * Creates a function that returns a connected Kafka Producer's produce function,
 * suitable for passing to EventGate as the produce function argument.
 * NOTE: This function uses undefined Kafka key and paritition when producing.
 * If you need to set key and/or partition, you should make your own produce function.
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
 * @param {KafkaProducer} producer
 *      Connected node-rdkafka Producer.
 * @return {function(Object, Object): Promise<Object>} (event, context) => Promise<event>
 */
function makeProduce(options, producer) {
    // This default EventGate implementation uses the stream_name
    // extracted from the event as the topic.
    const extractTopic = makeExtractStreamName(options);

    // Return a new function that takes a single event argument for produce.
    return (event, context = {}) => {
        const topic = extractTopic(event);
        const serializedEvent = Buffer.from(JSON.stringify(event));
        return producer.produce(topic, undefined, serializedEvent, undefined);
    };
}


/**
 * Returns a Promise of an instantiated EventGate that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  This
 * instance does not do any producing of error events.
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {stirng} options.stream_field
 *      Optionally used to extract the event's destination stream name.
 * @param {Object} options.kafka
 * @param {Object} options.kafka.options
 *      node-rdkafka KafkaProducer optionsiguration
 * @param {Object} options.kafka.topic_options
 *      node-rdkafka KafkaProducer topic optionsiguration
 * @param {bunyan logger} logger
 * @return {Promise<EventGate>}
 */
async function eventGateFactory(options, logger) {
    // Set default options
    _.defaults(options, defaultOptions);

    const kafkaProducer = await kafka.GuaranteedProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );

    return new EventGate({
        // This EventGate instance will use the EventValidator's
        // validate function to validate incoming events.
        validate:   makeValidate(options, logger),
        // This EventGate instance will use a kafka producer
        produce:    makeProduce(options, kafkaProducer),
        log:        logger
    });
}

module.exports = {
    factory: eventGateFactory,
    defaultOptions,
    makeExtractStreamName,
    makeExtractSchemaUri,
    makeValidate,
    makeProduce
};
