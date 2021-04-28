'use strict';

const P      = require('bluebird');
const Ajv    = require('ajv');
const _      = require('lodash');
const bunyan = require('bunyan');

const {
    urlGetObject,
} = require('@wikimedia/url-get');

const {
    objectGet
} = require('./event-util');

const {
    ValidationError,
    EventSchemaLoadError
} = require('./error');

// This will be used to make sure that all schemas
// are 'secure' for AJV compilation.
// See: https://www.npmjs.com/package/ajv#security-considerations
const secureMetaSchema = require('ajv/lib/refs/json-schema-secure.json');

const defaultOptions = {
    extractSchemaUri: (event) => objectGet(event, '$schema'),
    getSchema: (uri) => urlGetObject(uri),
    ajvConfig: {
        useDefaults: true,
        schemaId: 'auto',
        allErrors: true,
    },
    // If a schema $id is ever encountered that matches this regex
    // during schema compilation, it will be added and cached as
    // an Ajv 'meta schema'.
    metaSchemaIdRegex: /^https?:\/\/json-schema.org\//,
    // Add draft-04 meta schema by default.
    metaSchemas: [require('ajv/lib/refs/json-schema-draft-04.json')],
    // If true, schemas will not be validated against AJV's jsons-schema-secure.
    allowInsecureSchemas: false,
    // This logger will be used if one is not provided to EventValidator constructor.
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
     * @name EventValidator~extractSchemaUri
     * @method
     * @param {Object} event
     * @return {string}
     */

    /**
     * @name EventValidator~getSchema
     * @method
     * @param {string} schema_uri
     * @return {Promise<Object>}
     */

    /**
     * @constructor
     * @param {Object} options
     * @param {EventValidator~extractSchemaUri} options.extractSchemaUri
     *      Given an event, this returns its JSONSchema URI.
     *      Default is to return the $schema field of an event.
     * @param {EventValidator~getSchema} options.getSchema
     *      Given a uri (often extracted from an event using extractSchemaUri),
     *      This will return the schema at that uri.  The default is to
     *      just download the content at URI as an object using urlGetObject,
     *      but you may implement this to do something smarter.
     * @param {Object} options.ajvConfig
     *      Any extra options to pass to new Ajv().
     * @param {Object} options.metaSchemas
     *      Extra Ajv meta schemas to add during instantiation.
     *      This can help avoid remote lookup of schema meta schemas
     *      (e.g. draft-0X JSONSchema from json-schema.org) during
     *      runtime. Default: draft-04.  (draft-07 is always supported).
     * @param {Object} options.metaSchemaIdRegex
     *      Schema $ids which are considered to be 'meta' schemas.
     *      This allows us to avoid infinite recursion for meta schemas loaded at
     *      runtime without manually adding them to Ajv on init. This allows us to
     *      support multiple JSONSchema draft versions at runtime
     *      with the same Ajv instance. It is preferred that you pre-load
     *      meta schemas your events will use with options.metaSchemas,
     *      but if you can't, this regex will allow you to guess.
     *      Default: any schema loaded from json-schema.org will be added as a meta schema.
     * @param {boolean} options.allowInsecureSchemas This is false by default, which will
     *      cause EventValidator to validate all loaded (non-meta) schemas against
     *      AJV's json-schema-secure meta schema.  This is a security measure to prevent
     *      schemas from including features that could potentially cause DOS attackers.
     *      This usually means that string fields with either pattern or format
     *      must also specify a maxLength.  If allowInsecureSchemas is true,
     *      this check will not be done and any JSONSchema feature will be allowed.
     * @param {Object} options.log an instantiated bunyan logger instance.
     */
    constructor(options = {}) {
        _.defaultsDeep(this, options, defaultOptions);

        // Create a log() function so that we can use this.log as the Ajv.
        // (Ajv expects an object with log(), warn() and error() functions.)
        this.log.log = this.log.info.bind(this.log);

        // Always use this logger and this EventValidator's loadSchema for this Ajv.
        this.ajvConfig.logger = this.log;
        this.ajvConfig.loadSchema = this.loadSchema.bind(this);
        this.ajv = new Ajv(this.ajvConfig);

        // Add any extra meta schemas this validator should support.
        if (this.metaSchemas) {
            this.metaSchemas.forEach((metaSchema) => {
                this.log.debug(`Adding meta schema ${this.ajv._getId(metaSchema)}`);
                this.ajv.addMetaSchema(metaSchema);
            });
        }
        // Both http and https can be used as the draft-07 $schema URL.
        // However, the draft-07 metaschema uses an http URL as its
        // $id field.  AJV caches schemas by their $id.  In order
        // to avoid a remote lookup of this metaschema if a
        // schema sets $schema to https, we manually cache the
        // local copy of draft-07 metaschema with the https URL.
        this.ajv.addSchema(
            require('ajv/lib/refs/json-schema-draft-07.json'),
            'https://json-schema.org/draft-07/schema'
        );

        // Add a meta schema to check if schemas are secure for AJV compilation.
        this.isSchemaSecure = this.ajv.compile(secureMetaSchema);
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
     * A note about $refs: If a $ref is not an absolute URL or an absolute path
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
     *
     * @param {string} uri
     * @return {Promise<Object>}
     */
    loadSchema(uri) {
        this.log.info(`Loading schema at ${uri}`);
        return this.getSchema(uri)
        .then((schema) => {
            this.log.trace({ schema }, `Loaded schema at ${uri}`);

            // If this schema has an id that matches metaSchemaIdRegex,
            // then it should be added as a meta schema. (We don't need
            // to check if it has already been added to Ajv, since if it was,
            // loadSchema would not have been called for it in the first place.)
            // NOTE: ajv._getId will return either schema.$id or schema.id depending
            // on the ajv config option 'schemaId', which defaults to 'auto'.
            const schemaId = this.ajv._getId(schema);
            if (schemaId && this.metaSchemaIdRegex && schemaId.match(this.metaSchemaIdRegex)) {
                this.log.info(`Adding schema at ${uri} with id ${schemaId} as meta schema.`);
                this.ajv.addMetaSchema(schema);
            } else if (!this.allowInsecureSchemas && !this.isSchemaSecure(schema)) {
                // Else this is not a meta schema.
                // Make sure that this schema is secure for AJV compilation.
                const errorMessage = `Schema at ${uri} is not secure for compilation`;
                const errors =  this.isSchemaSecure.errors;
                this.log.error({ errors }, errorMessage);
                throw new ValidationError(errorMessage, errors);
            }

            return schema;
        });
    }

    /**
     * Returns a Promise of the schema for this event.
     *
     * @param {Object} event
     * @return {Promise<Object>} JSONSchema
     * @throws {EventSchemaLoadError} if the event schema URI fails loading.
     */
    schemaFor(event) {
        return this.validatorFor(event).then((validator) => validator.schema);
    }

    /**
     * Given a schema URI, this will load, compile, and cache the schema there.
     * If the schema URI or $id has been seen before, it will
     * be loaded from the AJV cache and not recompiled.
     *
     * @param {string} uri
     * @return {Promise<Function>}
     * @throws {EventSchemaLoadError}
     */
    validatorAt(uri) {
        // If this uri has been seen before, return the already compiled
        // and cached AJV validator.
        const validator = this.ajv.getSchema(uri);
        if (validator) {
            return P.resolve(validator);
        } else {
            // Else load the event's schema from its schema uri and compile it.
            return this.loadSchema(uri)
            // Wrap Event schema loading errors in EventSchemaLoadError
            .catch((error) => {
                throw new EventSchemaLoadError(
                    `Failed loading schema at ${uri}`,
                    { originalError: error, uri: uri }
                );
            })
            .then((schema) => {
                this.log.trace(`Compiling validator for schema at ${uri}`);
                return this.ajv.compileAsync(schema).then((validatorFn) => {
                    // Also cache this schema at uri if uri is different than schema.$id
                    // and this schema uri hasn't yet been added to the AJV cache
                    if (_.isUndefined(this.ajv.getSchema(uri))) {
                        this.log.debug(
                            'Additionally caching schema with $id ' +
                            `'${validatorFn.schema.$id}' by schema URI ` +
                            `${uri}`
                        );
                        this.ajv.addSchema(validatorFn.schema, uri);
                    }

                    this.log.trace(
                        `Compiled and cached validator for schema at ${uri}`
                    );
                    return validatorFn;
                });
            });
        }
    }

    /**
     * Returns a Promise of a validate function for the event.
     * The event's schema URI will be extracted using the provided extractSchemaUri function.
     *
     * @param {Object} event
     * @return {Promise<Function>}
     * @throws {EventSchemaLoadError}
     */
    validatorFor(event) {
        // Extract the schemaUri for this event and get a validator for it.
        return this.validatorAt(this.extractSchemaUri(event));
    }

    /**
     * Returns a Promise of the validated event using it's JSONSchema at its schema URL,
     * Or throws an ValidationError.
     *
     * @param {Object} event
     * @return {Promise<Object>} event (with defaults filled in by AJV validator).
     * @throws {ValidationError}
     */
    validate(event) {
        return this.validatorFor(event)
        .then((validateFn) => {
            if (!validateFn(event)) {
                throw new ValidationError(
                    `Event failed validation with schema at ${this.extractSchemaUri(event)}`,
                    validateFn.errors
                );
            }
            return event;
        });
    }
}

module.exports = EventValidator;
