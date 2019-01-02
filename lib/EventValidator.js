'use strict';

const P      = require('bluebird');
const Ajv    = require('ajv');
const _      = require('lodash');
const bunyan = require('bunyan');

const {
    urlGetObject,
    objectGet,
    uriHasProtocol
} = require('./event-util');

const {
    EventInvalidError,
    EventSchemaLoadError
} = require('./error');


const defaultOptions = {
    extractSchemaUri: event => objectGet(event, '$schema'),
    resolveSchemaUri: uri => uri,
    ajvConfig: {},
    // Add draft-04 meta schema by default.
    // Ajv will look first for $id and then id to cache schemas by,
    // unless the ajv schemaId option is set in ajvConfig.
    metaSchemas: [require('ajv/lib/refs/json-schema-draft-04.json')],
    // This logger will be used if one is not provided to EventValidator contructor.
    log: bunyan.createLogger(
        { name: 'EventValidator', src: true, level: 'info' }
    )
};

/**
 * Represents an event validator that uses schemas extracted from events using
 * extractSchemaUri.  URIs extracted from events are then resolved with
 * resolveSchemaUri, and then JSON schemas at the resulting URL are downloaded.
 * Those schemas are used to create cached AJV validators.  Note that
 * AJV will cache schema validators both by the event schema URI and the schema's
 * $id field.
 *
 * This class's validate method is intended to be used as an EventGate validate function.
 */
class EventValidator {
    /**
     * @param {Object} options
     * @param {function<(Object) => string} options.extractSchemaUri
     *      Given an event, this returns its JSONSchema URI.
     *      Default is to return the $schema field of an event.
     * @param {function<(Object) => string} options.resolveSchemaUri
     *      Given a uri, this will return a resolved schema url.
     *      Default is to just return the uri as given.
     * @param {Object} options.ajvConfig
     *      Any extra options to pass to new Ajv().
     * @param {Object} options.metaSchemas
     *      Extra schemas which are considered to be 'meta' schemas, rather than
     *      event schemas.  These will be added to Ajv with addMetaSchema.
     *      Default: draft-04.  (draft-07 is always supported).
     * @param {Object} options.log an instantiated bunyan logger instance.
     */
    constructor(options = {}) {
        _.defaults(this, options, defaultOptions);

        // Create a log() funtion so that we can use this.log as the Ajv.
        // (Ajv expects an object with log(), warn() and error() functions.)
        this.log.log = this.log.info.bind(this.log);

        const defaultAjvConfig = {
            useDefaults: true,
            schemaId: 'auto',
            allErrors: true,
            logger: this.log,
            loadSchema: this.loadSchema.bind(this),
        };
        _.defaults(this.ajvConfig, defaultAjvConfig);
        this.ajv = new Ajv(this.ajvConfig);
        // Add any extra meta schemas this validator should support.
        this.metaSchemas.forEach(metaSchema => this.ajv.addMetaSchema(metaSchema));
    }

    /**
     * This function is used as the ajv loadSchema option.  It is
     * also used by validatorFor to load a schema
     * from an event's configured schema_uri_field (default '$schema').
     *
     * We need to be able to handle both relative event schema URIs
     * (which should be prepended with the schema_base_uri), as well
     * as absolute $schema URLs, e.g. http://my.schemas.org/test/schema/0.0.1
     * To do this, only URIs without protocol schemes will be passed
     * through this.resolveSchemaUri() before attempting to download the content.
     * loadSchema will then return a Promise of the schema content at the URL.
     *
     * A note about $refs: If a $ref is not an absolute URL or an aboslute path
     * (starting with /), it will be passed to this function by ajv relative
     * to the enclosing schema's $id field. See: https://ajv.js.org/#ref.
     * E.g. if the enclosing schema has $id: /mediawiki/revision/create/0.0.3
     * a $ref of meta/0.0.2 will be given to this function as
     * mediawiki/revision/create/meta/0.0.2, which is likely wrong.
     * However, if the $ref is /meta/0.0.2, it will be passed as is.
     * We need to make sure that any event schema URIs that are not
     * absolute URLs (i.e. with a protocol scheme) including
     * ones used in $ref start with '/'. That will allow us to resolve
     * both $refs (given by AJV) and event schema URIs using the provided
     * this.resolveSchemaUri function.
     * @param {string} uri
     * @return {Promise<Object>}
     */
    loadSchema(uri) {
        let url = uri;
        // resolve any URIs that don't already have a protocol scheme
        if (!uriHasProtocol(url)) {
            url = this.resolveSchemaUri(uri);
            this.log.debug(`Resolved schema uri ${uri} to ${url}.`);
        }

        this.log.info(`Loading schema at ${url}`);
        return urlGetObject(url)
        .then((schema) => {
            this.log.debug({ schema }, `Loaded schema at ${url}`);
            return schema;
        });
    }

    /**
     * Returns a Promise of the schema for this event.
     * @param {Object} event
     * @return {Promise<Object>} JSONSchema
     * @throws {EventSchemaLoadError} if the event schema URI fails loading.
     */
    schemaFor(event) {
        return this.validatorFor(event).then(validator => validator.schema);
    }

    /**
     * Returns a Promise of a validate function for the event.
     * If the event's schema URI or $id has been seen before, it should
     * be loaded from the AJV cache and not recompiled.
     * @param {Object} event
     * @return {Promise<function(Object) => Object}}
     * @throws {EventSchemaLoader}
     */
    validatorFor(event) {
        // Extract the schemaUri for this event.
        const eventSchemaUri = this.extractSchemaUri(event);
        this.log.trace(`Getting validator for event schema ${eventSchemaUri}`);

        // If this eventSchemaUri has been seen before, return the already compiled
        // and cached AJV validator.
        const validator = this.ajv.getSchema(eventSchemaUri);
        if (validator) {
            return P.resolve(validator);
        } else {
            // Else load the event's schema from its schema uri and compile it.
            return this.loadSchema(eventSchemaUri)
            // Wrap Event schema loading errors in EventSchemaLoadError
            .catch((error) => {
                throw new EventSchemaLoadError(
                    `Failed loading schema at ${eventSchemaUri}`,
                    { error, event_schema_uri: eventSchemaUri }
                );
            })
            .then((schema) => {
                return this.ajv.compileAsync(schema).then((validatorForEvent) => {
                    // Also cache this schema at uri if uri is different than schema.$id
                    // and this schema uri hasn't yet been added to the AJV cache
                    if (_.isUndefined(this.ajv.getSchema(eventSchemaUri))) {
                        this.log.debug(
                            `Additionally caching schema with $id ` +
                            `'${validatorForEvent.schema.$id}' by event schema URI ` +
                            `${eventSchemaUri}`
                        );
                        this.ajv.addSchema(validatorForEvent.schema, eventSchemaUri);
                    }
                    return validatorForEvent;
                });
            });
        }
    }

    /**
     * Returns a Promise of the validated event using it's JSONSchema at its schema URL,
     * Or throws an EventInvalidError.
     * @param {Object} event
     * @return {Promise<Object>} event (with defaults filled in by AJV validator).
     * @throws {EventInvalidError}
     */
    validate(event) {
        return this.validatorFor(event)
        .then((validateFn) => {

            if (!validateFn(event)) {
                throw new EventInvalidError(
                    `Event failed validation with schema at ${this.extractSchemaUri(event)}`,
                    validateFn.errors
                );
            }
            return event;
        });
    }
}

module.exports = EventValidator;
