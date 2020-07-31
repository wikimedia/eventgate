'use strict';

const fs             = require('fs');
const _              = require('lodash');
const EventGate      = require('../eventgate.js').EventGate;

const {
    once
} = require('events');

const {
    makeValidate,
} = require('./default-eventgate');


/**
 * This file contains various functions for configuring and creating a 'development' EventGate
 * instance.
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
 * - schema_base_uris
 *      Base uris in which to prepend to values extracted from event schema_uri_fields
 *      and search for a schema.
 *      Default: undefined
 *
 * - schema_file_extension
 *      A file extension to append to the extracted schema_uri_field if its
 *      URI doesn't already have one.
 *      Default: undefined
 *
 * - output_path
 *      If set, valid events will be written to this file.
 *      Otherwise, valid events will just be logged to stdout.
 *      Default: undefined.
 */


const defaultOptions = {
    schema_uri_field:       '$schema',
    schema_base_uris:       undefined,
    schema_file_extension:  undefined,
    output_path:            undefined,
};

/**
 * Creates a function that writes events to output_path.
 * @param {Object} options
 * @param {Object} options.output_path
 * @param {Object} logger
 * @return {EventGate~produce} (event, context) => Promise<event>
 */
function makeProduce(options, logger) {
    const writeOptions = { flags: 'as' };
    if (!options.output_path) {
        // If fd is set, createWriteStream will ignored output_path
        writeOptions.fd = process.stdout.fd;
        logger.info('Writing valid events to stdout');
    } else {
        logger.info('Writing valid events to ' + options.output_path);
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
 * Returns a Promise of an instantiated EventGate that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  This
 * instance does not do any producing of error events.
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uris
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 * @param {Object} options.output_path
 *      If set, events will be written to this file, else events will be written to stdout.
 * @param {Object} logger
 * @return {Promise<EventGate>}
 */
async function devEventGateFactory(options, logger) {
    // Set default options
    _.defaults(options, defaultOptions);

    return new EventGate({
        // This EventGate instance will use the EventValidator's
        // validate function to validate incoming events.
        validate:   makeValidate(options, logger),
        // This EventGate instance will use a kafka producer
        produce:    makeProduce(options, logger),
        log:        logger
    });
}

module.exports = {
    factory: devEventGateFactory,
    defaultOptions,
    makeValidate,
    makeProduce
};
