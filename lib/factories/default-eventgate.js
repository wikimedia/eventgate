'use strict';

const _              = require('lodash');

const {
    uriGetFirstObject
} = require('@wikimedia/url-get');

const EventValidator = require('../EventValidator');
const EventGate      = require('../eventgate.js').EventGate;

const {
    makeExtractField,
} = require('../event-util');

/**
 * This file contains various functions for configuring and creating a 'default' EventGate
 * instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventGate instance.
 *
 * If kafka.conf is provided, node-rdkafka-factory (and node-rdkafka) will be
 * required and the this EventGate will produce to Kafka.  node-rdkafka-factory
 * is an optional dependency, so make sure it is properly installed.
 *
 * If output_path is configured, this EventGate will produce to output_path.
 * Both kafka and file output are simulataneously supported, depending
 * on what is configured.
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
 *      If this is not given, the schema_uri_field will be used to construct
 *      a sanitized stream name.
 *       If this is an array, the event will be searched for a field
 *      named by each element.  The first match will be used.
 *      This allows you to support events that might have
 *      Their stream fields at different locations.
 *      Default: undefined
 *
 * - output_path
 *      If set, valid events will be written to this file.
 *      A value of 'stdout' will write events to stdout.
 *      Default: stdout.
 *
 * - kafka.conf
 *      node-rdkafka KafkaProducer configuration
 *      If set, events will be produced to Kafka.
 *
 * - kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 */

const defaultOptions = {
    schema_uri_field: '$schema',
    schema_base_uri: undefined,
    schema_file_extension: undefined,
    stream_field: undefined,
    output_path: 'stdout',
    // disable Kafka produce by default so we can have node-rdkafka as an optional dependnecy.
    // kafka: {
    //     conf: {
    //         'metadata.broker.list': 'localhost:9092'
    //     },
    //     topic_conf: {}
    // },
};

/**
 * Returns a function that extracts the event's schema URI.
 *
 * @param {Object} options
 * @param {string|Array<string>} options.schema_uri_field
 *      Field(s) used to extract the schema_uri from an event.
 *      If this is an array, the event will be searched for a field
 *      named by each element. The first match will be used.
 *      This allows you to support events that might have
 *      Their schema_uris at different locations.  If this is not set,
 *      defaultOptions.schema_uri_field will be used.
 * @return {function(Object, Object): string}
 */
function makeExtractSchemaUri(options) {
    const schemaUriField = _.get(options, 'schema_uri_field', defaultOptions.schema_uri_field);
    return makeExtractField(schemaUriField);
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
 *
 * @param {Object} options
 * @param {string} options.stream_field
 *      If given, used to extract the event's destination stream name.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI to use as a sanitized stream name.
 *      This is only used if options.stream_field is not given.
 *      If this is an array, the event will be searched for a field
 *      named by each element. The first match will be used.
 *      This allows you to support events that might have
 *      Their stream name fields at different locations.
 * @return {function(Object, Object): string}
 */
function makeExtractStream(options) {
    // If no stream_field in event, fallback to sanitized schema uri
    if (_.isUndefined(options.stream_field)) {
        const extractSchemaUri = makeExtractSchemaUri(options);
        // eslint-disable-next-line prefer-regex-literals
        const badCharsRegex = new RegExp('[^A-Za-z0-9_.-]', 'g');
        const replacementChar = '_';

        const beginningReplacedRegex = new RegExp(`^${replacementChar}+`);
        return (event, context = {}) => {
            const schemaUri = extractSchemaUri(event);
            const stream = schemaUri.replace(badCharsRegex, replacementChar);
            // If there were any bad chars at beginning of schema_uri (e.g. /),
            // They will have been converted to underscores.  That's a bit ugly,
            // so remove them.
            return stream.replace(beginningReplacedRegex, '');
        };
    } else {
        return makeExtractField(options.stream_field);
    }
}

/**
 * Creates a new schema URI based validate(event) function.
 *
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {Object} logger
 * @return {EventGate~validate}
 */
function makeValidate(options, logger) {

    /**
     * Searches options.schema_base_uris/uri for schema content, and returns
     * the first one found.
     *
     * @param {string} uri
     * @return {EventValidator~getSchema}
     */
    function getSchema(uri) {
        return uriGetFirstObject(uri, options.schema_base_uris, options.schema_file_extension);
    }

    const eventValidator = new EventValidator({
        extractSchemaUri: makeExtractSchemaUri(options),
        getSchema,
        log: logger
    });

    return (event) => {
        return eventValidator.validate(event);
    };
}

/**
 * Creates a function that writes events to output_path.
 *
 * @param {Object} options
 * @param {Object} options.output_path
 * @param {Object} logger
 * @param {Object} metrics
 * @return {EventGate~produce} (event, context) => Promise<event>
 */
function makeFileProduce(options, logger, metrics) {
    const fs = require('fs');
    const {

        once
    } = require('events');

    const writeOptions = { flags: 'as' };
    if (options.output_path === 'stdout') {
        // If fd is set, createWriteStream will ignore output_path.
        writeOptions.fd = process.stdout.fd;
    }
    const outputStream = fs.createWriteStream(options.output_path || './output.json', writeOptions);

    return async (event, context = {}) => {
        const serializedEvent = Buffer.from(JSON.stringify(event) + '\n');
        if (!outputStream.write(serializedEvent)) {
            await once(outputStream, 'drain');
        }
    };
}

/**
 * Creates a function that returns function that produces events to Kafka.
 * NOTE: This function uses undefined Kafka key and partition when producing.
 * If you need to set key and/or partition, you should make your own produce function.
 *
 * @param {Object} options
 * @param {string} options.stream_field
 *      Used to construct the kafka topic
 * @param {string} options.schema_uri_field
 *      Used to construct the kafka topic if stream_field is not set.
 * @param {Object} options.kafka.conf
 *      node-rdkafka KafkaProducer configuration
 * @param {Object} options.kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 * @param {Object} logger
 * @param {Object} metrics
 *      service-runner metrics object, used if statistics.interval.ms is set
 *      to collect rdkafka metrics.
 * @return {Promise<{function}>} (event, context) => Promise<event>>
 */
async function makeKafkaProduce(options, logger, metrics) {
    // Hack to work around eslint node/no-missing-require rule.
    // We could disable the rule for this line, but then it would fail lint
    // when this optionalDependency is installed.
    // By making this look like a dynamic import, node/no-missing-require can't check it.
    const rdkafkaFactoryModule = '@wikimedia/node-rdkafka-factory';
    const kafkaFactory = require(rdkafkaFactoryModule);

    // This default EventGate implementation uses the stream_name
    // extracted from the event as the topic.
    const extractTopic = makeExtractStream(options);

    const kafkaProducer = await kafkaFactory.GuaranteedProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );

    // If rdkafka is configured with statistics reporting turned on,
    // AND if we are given a metrics object (node-statsd like or from service-runner app directly)
    // then enable Kafka metrics reporting using node-rdkafka-statsd.
    if (options.kafka.conf['statistics.interval.ms'] && metrics) {
        const rdkafkaStatsd  = require('node-rdkafka-statsd');
        logger.info('Enabling Kafka metrics reporting for Kafka producer');

        kafkaProducer.on(
            'event.stats',
            rdkafkaStatsd(metrics.makeChild('rdkafka.producer'))
        );
    }

    // Return a new function that takes a single event argument for produce.
    return (event, context = {}) => {
        const topic = extractTopic(event);
        const serializedEvent = Buffer.from(JSON.stringify(event));
        return kafkaProducer.produce(topic, undefined, serializedEvent, undefined);
    };
}

/**
 * Creates a function that will write events to an output file and/or
 * produce events to Kafka.
 *
 * @param {Object} options
 * @param {string} options.stream_field
 *      Used to construct the kafka topic
 * @param {string} options.schema_uri_field
 *      Used to construct the kafka topic if stream_field is not set.
 * @param {string} options.key_field
 *      If given, the event's 'key' will be extracted from the event at this dotted object path.
 * @param {string} options.partition_field
 *      If given, the event's 'partition' will be extracted from the event at this
 *      dotted object path.
 * @param {Object} options.output_path
 *      If given, events will be written to this file.  If 'stdout' events will be
 *      written to stdout.
 * @param {Object} options.kafka.conf
 *      If given, events will be produced to Kafka.
 *      node-rdkafka KafkaProducer configuration
 * @param {Object} options.kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 * @param {Object} logger
 * @param {Object} metrics
 *      service-runner metrics object.
 * @return {Promise<{function}>} (event, context) => Promise<event>>}
 */
async function makeProduce(options, logger, metrics) {

    let fileProduce;
    if (options.output_path) {
        fileProduce = makeFileProduce(options, logger, metrics);
        logger.info('Writing valid events to ' + options.output_path);
    }

    let kafkaProduce;
    if (options.kafka && options.kafka.conf) {
        kafkaProduce = await makeKafkaProduce(options, logger, metrics);
        logger.info('Producing valid events to Kafka at ' + options.kafka.conf['metadata.broker.list']);
    }

    // Return a new function that takes a single event argument for produce.
    return async (event, context = {}) => {
        if (fileProduce) {
            await fileProduce(event, context);
        }
        if (kafkaProduce) {
            await kafkaProduce(event, context);
        }
    };
}

/**
 * Returns a Promise of an instantiated EventGate that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  This
 * instance does not do any producing of error events.
 *
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {string} options.stream_field
 *      Optionally used to extract the event's destination stream name.
 * @param {Object} options.kafka
 * @param {Object} options.kafka.conf
 *      node-rdkafka KafkaProducer configuration
 * @param {Object} options.kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 * @param {Object} logger
 * @param {Object} metrics service-runner statsd-like metrics interface.  This is provided from
 *      service-runner app.  https://github.com/wikimedia/service-runner#metric-reporting
 * @return {Promise<EventGate>}
 */
async function eventGateFactory(options, logger, metrics) {
    // Set default options
    _.defaults(options, defaultOptions);

    return new EventGate({
        // This EventGate instance will use the EventValidator's
        // validate function to validate incoming events.
        validate: makeValidate(options, logger),
        // This EventGate instance will use a kafka producer
        produce: await makeProduce(options, logger, metrics),
        log: logger
    });
}

module.exports = {
    factory: eventGateFactory,
    defaultOptions,
    makeExtractStream,
    makeExtractSchemaUri,
    makeValidate,
    makeProduce,
    makeFileProduce,
    makeKafkaProduce
};
