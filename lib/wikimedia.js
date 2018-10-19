'use strict';

const _        = require('lodash');
const kafka = require('../lib/kafka');
const eUtil = require('../lib/eventbus-utils');
const EventValidator = require('../lib/validator').EventValidator;
const EventInvalidError = require('../lib/validator').EventInvalidError;
const EventBus = require('../lib/eventbus').EventBus;


// TODO rename this file?  Make a working Kafka generic eventbus_init_module too?

/**
 * This file contains various functions for configuring Wikimedia's
 * EventBus deployments. These use Express app.conf objects to create functions
 * that the EventBus class can use to validate and produce events
 * given only the event object itself.
 */


// TODO: review and clean up the functions in this file a bit,
// add docs.
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

function createValidatorFunction(conf) {
    const validator = new EventValidator(
        createSchemaUrlExtractorFunction(conf)
    );
    return validator.validate.bind(validator);
}

function prefixTopic(topic, prefix) {
    return prefix ? prefix + topic : topic;
}

function extractTopic(event, conf) {
    return prefixTopic(
        eUtil.objectProperty(conf.stream_field, event),
        conf.topic_prefix
    );
}

function extractKey(event, conf) {
    return undefined;
}

function extractPartition(event, conf) {
    return undefined;
}

function createEventReprFunction(conf) {
    return (event) => {
        const eventId = eUtil.objectProperty(conf.id_field, event, 'unknown');
        const schemaUri = eUtil.objectProperty(conf.schema_field, event, 'unknown');
        return `Event ${eventId} of schema ${schemaUri}`;
    };
}

function createProduceFunction(producer, conf) {
    return (event) => {
        return producer.produce(
            extractTopic(event, conf),
            extractPartition(event, conf),
            Buffer.from(JSON.stringify(event)),
            extractKey(event)
        );
    };
}

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

function createEventBus(conf, logger) {
    return kafka.createKafkaProducer(
        conf.kafka.conf,
        conf.kafka.topic_conf
    ).then((producer) => {
        return new EventBus(
            createValidatorFunction(conf),
            createProduceFunction(producer, conf),
            createEventReprFunction(conf),
            logger
        );
    });
}

// Return a function that instantiates eventbus and createEventError
// based on conf and logger.
module.exports = (conf, logger) => {
    return {
        eventbus: createEventBus(conf, logger),
        createEventError: createEventErrorFunction(conf)
    };
};
