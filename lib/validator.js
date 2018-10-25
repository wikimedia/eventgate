'use strict';

const P        = require('bluebird');
const Ajv      = require('ajv');
const _        = require('lodash');

const {
    urlGetObject,
    objectProperty,
    resolveUri,
    uriHasProtocol,
    loggerFactory
} = require('./event-utils');


class EventInvalidError extends Error {
    constructor(schemaUri, errors) {
        super(`Event failed validation with schema at ${schemaUri}.`);
        this.errors = errors;
        this.errorsText = errors.map(err => `'${err.dataPath}' ${err.message}`).join(', ');
    }
}

/**
 * Represents an event validator schemas extracted from events using
 * extractSchemaUri.  URIs extracted from events are then resolved with
 * resolveSchemaUri, and then JSON schemas at the resulting URL are downloaded.
 * Those schemas are used to create cached AJV validators.  Note that
 * AJV will cache schema validators by the schema's $id field.  It is assumed
 * that all event schema URIs match exactly the schema's $id field.
 */
class EventValidator {
    /**
     * @param {function<(Object) => string} extractSchemaUri given an event, this returns
     *      its JSONSchema URI. Default is to return the $schema field of an event.
     * @param {function<(Object) => string} resolveSchemaUri given a uri, this will
     *      return a resolved schema url. Default is to just return the uri as given.
     * @param {Object} ajvConfig Any extra options to pass to new Ajv().
     * @param {Object} logger an instantiated bunyan logger instance.
     */
    constructor(
        extractSchemaUri = event => objectProperty('$schema', event),
        resolveSchemaUri = uri => uri,
        ajvConfig = {},
        logger
    ) {
        this.log = loggerFactory(logger, { name: 'EventValidator' });

        // set a log funtion so that we can pass this as the Ajv
        // logger option??? TODO: really?
        this.log.log = this.log.info.bind(this.log);

        const defaultAjvConfig = {
            useDefaults: true,
            schemaId: 'auto',
            allErrors: true,
            logger: this.log,
            loadSchema: this.loadSchema.bind(this),
        };

        this.ajv = new Ajv(Object.assign(defaultAjvConfig, ajvConfig));

        this.extractSchemaUri = extractSchemaUri;
        this.resolveSchemaUri = resolveSchemaUri;
    }

    // TODO: PROBLEM:
    // What do we do if meta schemas (in the $schema) property

    // - WE need to always resolve extracted event schema URIs.
    // - loadSchema MUST resolve URIs, because we will use relative
    //   schema URIs for event $refs.
    // - we should NOT resolve a uri IF it is an absolute uri.
    // - HOWEVER, relative $ref uris will be provided to this function
    //   relative to the enclosing schema's $id field.
    //   e.g. if the enclosing schema has $id: mediawiki/revision/create/3
    //   a $ref of meta/2 will be given to this function as
    //   mediawiki/revision/create/meta/2.
    //
    // The only way to get around this that I can see is to make sure
    // all $ref (and possibly schema URI $ids) are 'absolute' paths
    // (not absolute URIs).  E.g. they should all start with slash.
    // schema_base_uri can still be prepended to them by resolveSchemaUri.

    /**
     * This function is used as the ajv loadSchema option.  It is
     * also used by validatorFor to load a schema
     * from an event's configured schema_uri_field (default '$schema').
     *
     * We need to be able to handle both relative event schema URIs
     * (which should be prepended with the schema_base_uri), as well
     * as absolute meta $schema URLs, e.g. http://json-schema.org/draft-07/schema#.
     * To do this, only URIs without protocol schemes will be passed
     * through this.resolveSchemaUri before attempting to download the content.
     * loadSchema will then return a Promise of the schema content at the URL.
     *
     * A note about $refs: If a $ref is not an absolute URL or an aboslute path
     * (starting with /), it will be passed to this function by ajv relative
     * to the enclosing schema's $id field. See: https://ajv.js.org/#ref.
     * E.g. if the enclosing schema has $id: mediawiki/revision/create/0.0.3
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
            this.log.trace({ schema }, `Loaded schema at ${url}`);
            return schema;
        });

    }

    /**
     * Returns a Promise of the schema for this event.
     * @param {Object} event
     * @return {Promise<Object>} JSONSchema
     */
    schemaFor(event) {
        this.validatorFor(event).then(validator => validator.schema);
    }

    validatorFor(event) {
        // Extract the schemaUri for this event.
        const eventSchemaUri = this.extractSchemaUri(event);

        // Schemas will be cached by in ajv by their $id fields.
        // The schema's $id must match schemaUri extracted from event.
        // TODO ASSERT that this is true.

        // If this eventSchemaUri has been seen before, return the already compiled
        // and cached AJV validator.
        const validator = this.ajv.getSchema(this.resolveSchemaUri(eventSchemaUri));
        if (validator) {
            return P.resolve(validator);
        } else {
            // Else load the event's schema from its schema uri and
            // compile it.
            return this.loadSchema(eventSchemaUri)
            .then((schema) => {
                // TODO ensure that schema.$id === eventSchemaUri?
                // but what if we aren't using draft 7?
                // compileAsync will cache the schema by its $id.
                return this.ajv.compileAsync(schema);
            });
            // TODO catch and log and error?
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
        .then((validate) => {
            if (!validate(event)) {
                throw new EventInvalidError(this.extractSchemaUri(event), validate.errors);
            }
            return event;
        });
    }
}

/**
 * Creates a new schema URI based EventValidator using app.conf settings.
 * conf.schema_uri_field, conf.schema_base_uri, and conf.schema_file_extension are all used.
 */
EventValidator.createFromConf = (conf, logger) => {
    const schemaUriField = _.get(conf, 'schema_uri_field', '$schema');
    return new EventValidator(
        event => objectProperty(schemaUriField, event),
        uri => resolveUri(uri, conf.schema_base_uri, conf.schema_file_extension),
        undefined,
        logger
    );
};

module.exports = {
    EventInvalidError,
    EventValidator
};
