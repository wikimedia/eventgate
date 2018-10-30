'use strict';

const _        = require('lodash');
const kafka = require('../../lib/kafka');
const Eventbus = require('../../lib/eventbus.js').Eventbus;

const eventValidate = require('../../lib/factories/event-validate');
const kafkaProduce  = require('../../lib/factories/kafka-produce');

// TODO: rename some functions here.

/**
 * This file contains various functions for configuring and creating a 'default' EventBus
 * instance using Express app.conf.  These functions all use a conf object
 * to configure new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions based on config for
 * creating an EventBus instance.
 *
 * The following keys are used in the conf object by functions in this file:
 *
 * - schema_uri_field
 *      The dotted object path to extract a schema_uri from an event.
 *      TODO: rename to schema_uri_field?
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
 * Creates a function that returns a string representation of an event.
 * Uses conf.id_field and conf.schema_uri_field.
 * TODO: rename schema_uri_field to schema_uri_field?
 * @param {Object} conf
 * @return {function(Object): string}
 */
function eventReprFromConf(conf) {
    return (event) => {
        let eventId = _.get(event, conf.id_field);
        // formatting for repr string if no event id.
        eventId = eventId ? `${eventId} ` : '';
        const schemaUri = _.get(event, conf.schema_uri_field, 'unknown');
        const streamName = _.get(event, conf.stream_field, 'unknown');

        return `Event ${eventId}with schema ${schemaUri} destined to ${streamName}`;
    };
}

// TODO:
function setConfDefaults(conf) {
    return _.defaults(conf, {
        schema_uri_field: '$schema'
    });
}

/**
 * Returns a Promise of an instantiated Eventbus that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  This
 * instance does not do any producing of error events.
 * @param {Object} conf
 * @param {bunyan logger} logger
 * @return {Promise<EventBus>}
 */
function eventbusFromConf(conf, logger, createEventError) {
    return kafka.createKafkaProducer(
        conf.kafka.conf,
        conf.kafka.topic_conf
    ).then((kafkaProducer) => {
        // TODO???
        if (!_.has(conf, 'schema_uri_field')) {
            conf.schema_uri_field = '$schema';
        }

        return new Eventbus({
            // This Eventbus instance will use
            // the eventValidator's validate function to validate
            // incoming events.
            validate: eventValidate.factory(conf, logger),
            // This Eventbus instance will use a kafka producer
            produce: kafkaProduce.factory(conf, kafkaProducer),
            eventRepr: eventReprFromConf(conf),
            log: logger
        });
    });
}

module.exports = {
    factory: eventbusFromConf,
    eventReprFromConf,
    setConfDefaults
};
