'use strict';

const _        = require('lodash');
const kafka = require('../lib/kafka');
const eUtil = require('./event-utils');
const EventValidator = require('../lib/validator').EventValidator;
const Eventbus = require('../lib/eventbus').Eventbus;


/**
 * This file contains various functions for configuring and creating an EventBus
 * instance using Express app.conf.  These functions all take in a conf
 * in which are configurations used to extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions based on app config for
 * creating an EventBus instance.
 *
 * The following keys are used in the conf object by functions in this file:
 *
 * - schema_field
 *      The dotted object path to extract a schema_uri from an event.
 *      TODO: rename to schema_uri_field?
 *
 * - schema_base_uri
 *      A base uri to prepend to values extracted from event schema_fields
 *
 * - schema_file_extension
 *      A file extension to append to the extracted schema_field if it URI doesn't already have one.
 *
 * - stream_field
 *      The dotted object path to the value to use for the topic/stream
 *      TODO: stream_field or topic_field?
 *
 * - topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used for the event topic.
 *
 * - key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 *      TODO.
 *
 *  - partition_field
 *      If given, the event's 'partition' will be extracted from the event at this dotted
 *      object path.
 *      TODO.
 *
 * - id_field
 *      This field will be used as the event's 'id' in log messages
 *
 * - kafka.conf
 *      node-rdkafka KafkaProducer configuration
 *
 * - kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 */


/**
 * Returns a new function that takes an event and returns it's schema URL.
 * The JSONSchema at this URL can be used to validate the event.
 *
 * This uses conf.schema_field, conf.schema_base_uri, and conf.schema_file_extension
 * @param {Object} conf
 * @return {function(Object): string}
 */
function createSchemaUrlExtractorFunction(conf) {
    return (event) => {
        return eUtil.extractUrl(
            conf.schema_field,
            conf.schema_base_uri,
            conf.schema_file_extension,
            event
        );
    };
}

/**
 * Returns a validate function that uses an EventValidator
 * with a function returned by createSchemaUrlExtractorFunction to
 * extract schema URLs from events.  The function returned
 * can validate an event and return it, or throws an EventInvalidError
 * if the event is invalid.
 * @param {Object} conf
 * @return {function(Object) => Object}
 */
function createValidateFunction(conf) {
    const validator = new EventValidator(
        createSchemaUrlExtractorFunction(conf)
    );
    return validator.validate.bind(validator);
}


/**
 * Creates a function that extracts a topic (and potentially adds a prefix)
 * using conf.stream_field and conf.topic_prefix.
 * @param {Object} conf
 * @return {function(Object): string}
 */
function createExtractTopicFunction(conf) {
    return (event) => {
        const streamName = eUtil.objectProperty(conf.stream_field, event);
        return conf.topic_prefix ?  conf.topic_prefix + streamName : streamName;
    };
}

/**
 * Creates a function that extracts a key, uses conf.key_field.
 * @param {Object} conf
 * @return {function(Object) => *= }
 */
function createExtractKeyFunction(conf) {
    if (_.has(conf, 'key_field')) {
        return event => eUtil.objectProperty(conf.key_field, event);
    } else {
        return event => undefined;
    }
}

/**
 *
 * @param {Object} conf
 * @return {function(Object): integer}
 */
function createExtractPartitionFunction(conf) {
    return (event) => {
        return conf.partition_field ? eUtil.objectProperty(conf.partition_field, event) : undefined;
    };
}

/**
 * Creates a function that returns a string representation of an event.
 * Uses conf.id_field and conf.schema_field.
 * TODO: rename schema_field to schema_uri_field?
 * @param {Object} conf
 * @return {function(Object): string}
 */
function createEventReprFunction(conf) {
    return (event) => {
        const eventId = eUtil.objectProperty(conf.id_field, event, 'unknown');
        const schemaUri = eUtil.objectProperty(conf.schema_field, event, 'unknown');
        return `Event ${eventId} of schema ${schemaUri}`;
    };
}

/**
 * Creates a function that returns a connected Kafka Producer's produce function,
 * suitable for passing to Eventbus as the produce function argument.
 * @param {Object} conf
 * @param {KafkaProducer} kafkaProducer
 * @return {function(Object): Promise<Object>}
 */
function createKafkaProduceFunction(conf, kafkaProducer) {
    // Create new functions that use static configuration
    // to extract Kafka produce() params from an event.
    const extractTopic = createExtractTopicFunction(conf);
    const extractPartition = createExtractPartitionFunction(conf);
    const extractKey = createExtractKeyFunction(conf);

    // Return a new function that takes a single event argument for produce.
    return (event) => {
        return kafkaProducer.produce(
            extractTopic(event, conf),
            extractPartition(event, conf),
            Buffer.from(JSON.stringify(event)),
            extractKey(event)
        );
    };
}

/**
 * Returns a Promise of an instantiated Eventbus that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.
 * @param {Object} conf
 * @param {bunyan logger} logger
 * @return {Promise<EventBus>}
 */
function createKafkaEventbus(conf, logger) {
    return kafka.createKafkaProducer(
        conf.kafka.conf,
        conf.kafka.topic_conf
    ).then((kafkaProducer) => {
        return new Eventbus(
            createValidateFunction(conf),
            createKafkaProduceFunction(conf, kafkaProducer),
            createEventReprFunction(conf),
            logger
        );
    });
}

module.exports = {
    createSchemaUrlExtractorFunction,
    createValidateFunction,
    createExtractTopicFunction,
    createExtractKeyFunction,
    createExtractPartitionFunction,
    createEventReprFunction,
    createKafkaProduceFunction,
    createKafkaEventbus
};
