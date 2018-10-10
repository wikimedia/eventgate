'use strict';

const P        = require('bluebird');
const _        = require('lodash');
const Ajv      = require('ajv');
const { URL }  = require('url');

const {
    urlGetObject,
    objectProperty,
    objectFactory,
    fileExtension
} = require('./eventbus-utils');


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
        ajvConfig={useDefaults: true, schemaId: 'auto', allErrors: true}
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
     *
     * @param {String} url of JSONSchema
     * @return {Promise<Object>} of JSONSchema object parsed by AJV at url.
     */
    schemaAt(url) {
        return this.validatorFor(url).then(v => v.schema);
    }


    /**
     * Returns Promose of an AJV validator function from the JSONSchema at url.
     * If this url has been seen before, the validator function will be returned out of
     * the validator cache.
     *
     * @param {String} url of JSONSchema
     * @return {Promise<function>} of an AJV validtor function for the JSONSchema at url.
     */
    validatorFor(url) {
        if (!this.validatorCache.has(url)) {
            // TODO debug/trace logging for when looking up validator vs. caching
            return this.getValidator(url).then((v) => {
                this.validatorCache.set(url, v);
                return v;
            });
        }
        else {
            return P.resolve(this.validatorCache.get(url));
        }
    }

    /**
     * Returns Promise of an AJV validator function for the JSONSChema at url.
     * This function does not cache any schema content, you should probably
     * use validatorFor instead.
     *
     * @param {String} url of JSONSchema
     * @return {Promise<function>} of an AJV validtor function for the JSONSchema at url.
     */
    getValidator(url) {
        return urlGetObject(url).then(schema => this.ajv.compile(schema))
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
 * Represents an event validator for schemas in a schema reposistory.
 * The schema respository is expected to be at baseSchemaUri
 * (file:// and http:// both supported).  Schemas for validating specific events
 * are expected to be located using the schemaUriField in the event.
 * That is, all events must have a property at schemaUriField that is a relative
 * (or fully qualified if baseSchemaUri is not provided) URI that links the
 * event to its schema.
 */
class EventValidator {
    //  TODO: use (partial) functions for constructing url from event.
    // TODO logging?
    constructor(extractSchemaUrlFn) {
        this.extractSchemaUrl = extractSchemaUrlFn;
        this.validators = new ValidatorCache();
    }

    // schemaUri(event, full=false) {
    //     if (_.isString(event))
    //         event = JSON.parse(event);

    //     //  TOOD: try/catch
    //     let uri = objectProperty(event, this.schemaUriField);

    //     if (full) {
    //         if (!fileExtension(uri)) {
    //             uri += '.' + this.schemaFileExtension;
    //         }
    //         // Join baseSchemaUri uri if schema uri is relative.
    //         return new URL(uri, this.baseSchemaUri).href;
    //     }
    //     else {
    //         return uri;
    //     }
    // }

    // schema(event) {
    //     if (_.isString(event))
    //         event = JSON.parse(event);

    //     return this.validators.getSchema(this.schemaUri(event, true));
    // }


    /**
     * Returns the schema URL of the schema that this event would be validated by.
     *
     * @param {Object} event
     * @return {String} JSONSchema URL
     */
    schemaUrl(event) {
        return this.extractSchemaUrl(event);
    }

    /**
     * Returns a promise of the schema for this event.
     * @param {Object} event
     * @return {Promise<Object>} JSONSchema
     */
    schema(event) {
        return this.validators.getSchema(schemaUrl(event));
    }

    /**
     * Returns a Promise of the validated event using it's JSONSchema at its schema URL,
     * Or throws an EventInvalidError.
     *
     * @param {Object} event
     * @return {Promise<Object>} event (with defaults filled in by AJV validator).
     * @throws {EventInvalidError}
     */
    validate(event) {
        // Make sure event is an object.
        event = objectFactory(event);

        const schemaUrl = this.extractSchemaUrl(event);

        // TODO: this is async...how does validate.errors work?  Is there race condition?
        return this.validators.validatorFor(schemaUrl).then((validate) => {
            if (!validate(event)) {
                throw new EventInvalidError(schemaUrl, validate.errors);
            }
            return event;
        });
    }
}




// var j = '{"comment": "hi", "database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schemaUri": "mediawiki/revision/create/3", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d = yaml.safeLoad(j)

// var j2 = '{"comment": 123, "database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schemaUri": "mediawiki/revision/create/3", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d2 = yaml.safeLoad(j2)


// var j3 = '{"database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schemaUri": "mediawiki/revision/create/2", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d3 = yaml.safeLoad(j3);

// var base_uri = 'file:///vagrant/srv/event-schemas/jsonschema/';


// var validator = new EventValidator(base_uri);
// validator.validate(d3).then(e => console.log(e));

// validator.validate(d2).then(e => console.log(e)).catch(e => console.log(e.message, e.errors));




module.exports = {
    EventInvalidError: EventInvalidError,
    EventValidator: EventValidator
}
