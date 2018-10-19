'use strict';

const P        = require('bluebird');
const Ajv      = require('ajv');

const urlGetObject = require('./event-utils').urlGetObject;


// TODO Add debug/trace logging of schemas as they are cached and used.

/**
 * Caches AJV validators by schema urls.
 *
 * Usage:
 *  validatorCache = new ValidatorCache();
 *  validator = validatorCache.validatorFor('file:///path/to/schema.yaml');
 *  schema = validatorCache.schemaAt('file:///path/to/schema.yaml');
 */
class ValidatorCache {
    /**
     * TODO
     */
    constructor(
        ajvConfig = { useDefaults: true, schemaId: 'auto', allErrors: true }
    ) {
        // TODO instantiate Ajv with defaults from config.
        this.ajv = new Ajv(ajvConfig);
        this.ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));

        this.validatorCache = new Map();
    }

    /**
     * Returns a Promise of the jsonschema object at url as parsed by AJV.
     * If this url has been seen before, the schema will be returned out of
     * the validator cache.
     * @param {string} url of JSONSchema
     * @return {Promise<Object>} of JSONSchema object parsed by AJV at url.
     */
    schemaAt(url) {
        return this.validatorFor(url).then(v => v.schema);
    }


    /**
     * Returns Promose of an AJV validator function from the JSONSchema at url.
     * If this url has been seen before, the validator function will be returned out of
     * the validator cache.
     * @param {string} url of JSONSchema
     * @return {Promise<Function>} of an AJV validtor function for the JSONSchema at url.
     */
    validatorFor(url) {
        if (!this.validatorCache.has(url)) {
            // TODO debug/trace logging for when looking up validator vs. caching
            return this.getValidator(url).then((v) => {
                this.validatorCache.set(url, v);
                return v;
            });
        } else {
            return P.resolve(this.validatorCache.get(url));
        }
    }

    /**
     * Returns Promise of an AJV validator function for the JSONSChema at url.
     * This function does not cache any schema content, you should probably
     * use validatorFor instead.
     * @param {string} url of JSONSchema
     * @return {Promise<Function>} of an AJV validtor function for the JSONSchema at url.
     */
    getValidator(url) {
        return urlGetObject(url).then(schema => this.ajv.compile(schema));
    }
}


class EventInvalidError extends Error {
    constructor(schemaUri, errors) {
        super(`Event failed validation with schema at ${schemaUri}.`);
        this.errors = errors;
        this.errorsText = errors.map(err => `'${err.dataPath}' ${err.message}`).join(', ');
    }

}

/**
 * Represents an event validator schemas extracted from events using
 * extractSchemaUrlFn.  JSONSchemas are retrieved from the schema URLs
 * extracted from the events.  Those schemas are used to create
 * cached AJV validators, cached by schema URL.
 */
class EventValidator {
    /**
     * @param {function<(Object) => string} extractSchemaUrl
     */
    constructor(extractSchemaUrl) {
        this.extractSchemaUrl = extractSchemaUrl;
        this.validators = new ValidatorCache();
    }

    /**
     * Returns the schema URL of the schema that this event would be validated by.
     * TODO maybe we don't need this function?  it isn't doing anything ATM.
     * @param {Object} event
     * @return {string} JSONSchema URL
     */
    schemaUrl(event) {
        return this.extractSchemaUrl(event);
    }

    /**
     * Returns a Promise of the schema for this event.
     * @param {Object} event
     * @return {Promise<Object>} JSONSchema
     */
    schema(event) {
        return this.validators.getSchema(this.schemaUrl(event));
    }

    /**
     * Returns a Promise of the validated event using it's JSONSchema at its schema URL,
     * Or throws an EventInvalidError.
     * @param {Object} event
     * @return {Promise<Object>} event (with defaults filled in by AJV validator).
     * @throws {EventInvalidError}
     */
    validate(event) {
        const schemaUrl = this.schemaUrl(event);
        // TODO: this is async...how does validate.errors work?  Is there race condition?
        return this.validators.validatorFor(schemaUrl).then((validate) => {
            if (!validate(event)) {
                throw new EventInvalidError(schemaUrl, validate.errors);
            }
            return event;
        });
    }
}

module.exports = {
    EventInvalidError,
    EventValidator
};
