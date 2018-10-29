'use strict';

const _         = require('lodash');
const objectGet = require('../../lib/event-utils').objectGet;


/**
 * This file contains functions that create a bound kafka produce(event)
 * function from Express app conf. The produce function returned
 * by factory() is suitable for use when instantiating an Eventbus.
 */


/**
 * Creates a function that extracts a topic (and potentially adds a prefix)
 * using conf.stream_field and conf.topic_prefix.
 * @param {Object} conf
 * @return {function(Object): string}
 */
function createExtractTopicFunction(conf) {
    return (event) => {
        const streamName = objectGet(event, conf.stream_field);
        return conf.topic_prefix ?  conf.topic_prefix + streamName : streamName;
    };
}

/**
 * Creates a function that extracts a Kafka key, uses conf.key_field.
 * @param {Object} conf
 * @return {function(Object) => *= }
 */
function createExtractKeyFunction(conf) {
    if (_.has(conf, 'key_field')) {
        return event => objectGet(event, conf.key_field);
    } else {
        return event => undefined;
    }
}

/**
 * Creates a function that extracts a kafka partition, useus conf.partition_field.
 * @param {Object} conf
 * @return {function(Object): integer}
 */
function createExtractPartitionFunction(conf) {
    return (event) => {
        return conf.partition_field ? _.get(event, conf.partition_field) : undefined;
    };
}

/**
 * Creates a function that returns a connected Kafka Producer's produce function,
 * suitable for passing to Eventbus as the produce function argument.
 * @param {Object} conf
 * @param {KafkaProducer} kafkaProducer
 * @return {function(Object): Promise<Object>}
 */
function createFromConf(conf, kafkaProducer) {
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

module.exports = {
    factory: createFromConf,
    createExtractTopicFunction,
    createExtractKeyFunction,
    createExtractPartitionFunction
};
