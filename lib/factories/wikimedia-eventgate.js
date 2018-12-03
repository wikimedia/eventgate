'use strict';

const _ = require('lodash');

const uuid = require('cassandra-uuid').TimeUuid;

const {
    urlGetObject,
    objectGet,
    resolveUri
} = require('../event-util');


const kafka = require('../kafka');
const EventValidator = require('../EventValidator');
const EventGate = require('../eventgate').EventGate;

// We'll use the makeExtractSchemaUri implementation that the
// default EventGate uses, but most of the Wikimedia specific produce
// related funciton implemenations are custom and will be defined in this file.
const {
    makeExtractSchemaUri
} = require('../factories/default-eventgate');

const {
    EventInvalidError
} = require('../error');


/**
 * This module can be used as the value of app.options.eventgate_factory_module.  It exports
 * a factory function that given options and a logger, returns an instantiated EventGate instance
 * that will produce to Kafka, and a mapToEventError function for transforming
 * errors into events that can be produced to an error topic.
 *
 * This file contains various functions for configuring and creating the main 'wikimedia'
 * EventGate instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventGate instance.
 *
 * This file uses some functions exported by default-eventgate module but also
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
        // Only produce error events for EventInvalidErrors.
        if (!(error instanceof EventInvalidError)) {
            // Returning null will cause this particular error event
            // to not be produced at all.
            return null;
        }

        const now = new Date();

        const eventError = {
            // TODO:
            // $schema: options.error_schema_uri,
            meta: {
                schema_uri: options.error_schema_uri,
                // TODO rename this to 'stream_name'.
                topic:      options.error_stream,
                id:         uuid.fromDate(now),
                dt:         now.toISOString(),
                uri:        _.get(event, 'meta.uri', 'unknown'),
                domain:     _.get(event, 'meta.domain', 'unknown')
            },
            emitter_id: options.user_agent || 'eventgate-service',
            raw_event: _.isString(event) ? event : JSON.stringify(event),
            // We know error is an EventInvalidError,
            // so we can use errorsText as error message.
            message: error.errorsText
        };

        if (_.has(event, 'meta.request_id')) {
            eventError.meta.request_id = event.meta.requestId;
        }

        return eventError;
    };
}


class MissingStreamFieldError extends Error {}

/**
 * All wikimedia events should have stream_field set.  The function
 * created by this function returns the value extracted from event at stream_field.
 * @param {Object} options
 * @param {stirng} options.stream_field
 * @return {function(Object, Object): string}
 */
function makeExtractStreamName(options) {
    return (event, context = {}) => {
        const streamName = _.get(event, options.stream_field);
        if (_.isUndefined(streamName)) {
            throw new MissingStreamFieldError(
                'Event stream name cannot be extracted. ' +
                `Event must have a '${options.stream_field}' property.`
            );
        }
        return streamName;
    };
}

class UnauthorizedSchemaForStreamError extends Error {}

/**
 * Creates a new schema URI based validate(event) function.
 * The returned function first checks the stream config to ensure
 * that the event's schema title is allowed in the event's destination stream.
 * It then uses an EventValidator instance to validate
 * the event against its schema.
 * @param {Object} options
 * @param {string} options.stream_config_uri
 *      URI to a stream config file.  This file should contain
 *      a mapping of stream name to config, most importantly including
 *      the stream's allowed schema title.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {bunyan logger} logger
 * @return {function(Object, Object): Promise<Object>}
 */
async function makeWikimediaValidate(options, logger) {
    // Get the streamConfig file at stream_config_uri.
    const streamConfig = await urlGetObject(options.stream_config_uri);

    const extractSchemaUri = makeExtractSchemaUri(options);
    const extractStreamName = makeExtractStreamName(options);

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

    // This EventValidator instance will be used to validate all incoming events.
    // Its loadSchema method will also be used to get the schema title field
    // when ensuring that events are allowed in streams via streamConfig.
    const eventValidator = new EventValidator({
        extractSchemaUri,
        resolveSchemaUri,
        log: logger
    });

    const schemaTitleField = 'title';
    const streamConfigSchemaTitleField = 'schema_title';

    /**
     * Uses streamConfig to verify that the event is allowed in streamName.
     * @param {Object} event
     * @param {string} streamName
     * @throws {UnauthorizedSchemaForStreamError}
     * @return {boolean} true if the schema is allowed in stream.
     */
    async function ensureEventAllowedInStream(event, streamName) {
        // Load the schema at schemaUri via eventValidator.
        // (This is cached inside of eventValidator's AJV instance.)
        logger.debug(
            `Loading schema for event to check if it is allowed in stream ${streamName}`
        );

        const schema      = await eventValidator.schemaFor(event);

        // TODO
        const schemaUri = schema.$id;

        // Get the title field out of the schema.  This must match
        // the allowed schema for this streamName.
        const schemaTitle = objectGet(schema, schemaTitleField);
        if (_.isUndefined(schemaTitle)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema at ${schemaUri} is not allowed in stream ${streamName}; ` +
                `'title' must be present in schema.`
            );
        }

        const specificStreamConfig = _.get(streamConfig, streamName);
        if (_.isUndefined(specificStreamConfig)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema at ${schemaUri} is not allowed in stream ${streamName}; ` +
                `${streamName} is not a configured stream.`
            );
        }

        // TODO support regexes in config schema_title.
        const allowedSchemaTitle = _.get(specificStreamConfig, streamConfigSchemaTitleField);

        if (_.isUndefined(allowedSchemaTitle)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema at ${schemaUri} is not allowed in stream ${streamName}; ` +
                `${streamName} does not have a configured schema_title.`
            );
        }

        // TODO: make this check smarter and use regexes.
        if (schemaTitle !== allowedSchemaTitle) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema ${schemaTitle} is not allowed in stream ${streamName}; ` +
                `must be ${allowedSchemaTitle}.`
            );
        }

        return true;
    }

    const validateFn = async(event, context = {}) => {
        // const schemaUri  = extractSchemaUri(event);
        const streamName = extractStreamName(event);

        // First ensure that this event schema is allowed in the destination stream.
        await ensureEventAllowedInStream(event, streamName);
        // Then validate the event against its schema.
        return eventValidator.validate(event);
    };

    validateFn.eventValidator = eventValidator;
    return validateFn;
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
    return (event, context = {}) => {
        const eventId    = _.get(event, options.id_field);
        const schemaUri  = _.get(event, options.schema_uri_field);
        const streamName = _.get(event, options.stream_name_field);

        /* eslint-disable */
        return 'event ' +
            eventId ? `${eventId} ` : '' +
            schemaUri ? `with schema at ${schemaUri}` : '' +
            streamName ? `destined to ${streamName}` : '';
        /* eslint-enable */
    };
}

/**
 * Creates a function that returns a Kafka produce function
 * suitable for passing to EventGate as the produce function argument.
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
 * @return {Promise<EventGate>}
 */
async function wikimediaEventGateFactory(options, logger) {
    _.defaults(options, defaultOptions);

    const validate = await makeWikimediaValidate(options, logger);

    // Create both a GuarunteedProducer and a HastyProducer.
    // Which one is used during produce() is determined by the
    // req.query.hasty parameter.
    const guarunteedProducer = await kafka.GuaranteedProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );
    const hastyProducer = await kafka.HastyProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );

    const produce = makeProduce(options, guarunteedProducer, hastyProducer);

    return new EventGate({
        validate,
        produce,
        eventRepr: makeEventRepr(options),
        log: logger,
        mapToErrorEvent: makeMapToErrorEvent(options)
    });
}


module.exports = {
    factory: wikimediaEventGateFactory,
    makeWikimediaValidate,
    UnauthorizedSchemaForStreamError,
    makeMapToErrorEvent
};
