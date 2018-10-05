'use strict';

const P = require('bluebird');
// todo promisify?
const yaml = require('js-yaml');
const _ = require('lodash');
const readFile = P.promisify(require('fs').readFile);
const preq = require('preq');
const Ajv = require('ajv');
const { URL } = require('url');
const path = require('path');

function url_get(url) {
    if (_.isString(url)) {
        url = new URL(url);
    }

    if (url.protocol == 'file:') {
        return readFile(url.pathname, 'utf-8')
    }
    else {
        return preq.get({uri: url.href}).then(res => res.body);
    }
}


function url_get_yaml(url) {
    return url_get(url).then(content => yaml.safeLoad(content));
}

function url_get_validator(url, ajv) {
}

function get_file_extension(uri) {
    path.basename(uri).split('.')[1];
}


class PropertyNotFoundError extends Error {}

function get_property(object, path) {
    return path.split('.').reduce((current, key) => {
        if (!_.has(current, key)) {
            throw new PropertyNotFoundError(`Property '${path}' not found in object`);
        }
        return current[key]
    }, object);
}


// TODO Add debug/trace logging of schemas as they are cached and used.

class ValidatorCache {
    constructor() {
        // TODO instantiate Ajv with defaults from config.
        this.ajv = new Ajv({useDefaults: true, schemaId: 'auto', allErrors: true});
        this.ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));


        this.validator_cache = new Map();
    }

    get_schema(url) {
        return this.get_validator(url).then(v => v.schema);
    }

    get_validator(url) {
        if (!this.validator_cache.has(url)) {
            // TODO debug/trace logging for when looking up validator vs. caching
            return this.url_get_validator(url).then((v) => {
                this.validator_cache.set(url, v);
                return v;
            });
        }
        else {
            return P.resolve(this.validator_cache.get(url));
        }
    }

    url_get_validator(url) {
        return url_get_yaml(url).then(s => this.ajv.compile(s))
    }
}

class EventInvalidError extends Error {
    constructor(schema_uri, errors) {
        super(`Event failed validation with schema ${schema_uri}.`);
        this.errors = errors;
        this.errorsText = errors.map(err => `'${err.dataPath}' ${err.message}`).join(', ');
    }

}

class EventValidator {
    constructor(base_schema_uri, schema_file_extension='yaml', schema_field='meta.schema_uri') {
        this.base_schema_uri = base_schema_uri;

        // new URL with base uri needs to end with / or the end of the
        // directory path will not be used!
        if (!_.endsWith(this.base_schema_uri, '/')) {
            this.base_schema_uri += '/';
        }

        this.schema_file_extension = schema_file_extension;
        this.schema_field = schema_field;

        this.validators = new ValidatorCache(base_schema_uri, schema_file_extension);
    }

    schema_uri(event, full=false) {
        if (_.isString(event))
            event = JSON.parse(event);

        //  TOOD: try/catch
        let uri = get_property(event, this.schema_field);

        if (full) {
            if (!get_file_extension(uri)) {
                uri += '.' + this.schema_file_extension;
            }
            // Join base_schema_uri uri if schema uri is relative.
            return new URL(uri, this.base_schema_uri).href;
        }
        else {
            return uri;
        }
    }

    schema(event) {
        if (_.isString(event))
            event = JSON.parse(event);

        return this.validators.get_schema(this.schema_uri(event, true));
    }

    validate(event) {
        if (_.isString(event))
            event = JSON.parse(event);

        const schema_uri = this.schema_uri(event, true);

        // TODO: this is async...how does validate.errors work?  Is there race condition?
        return this.validators.get_validator(schema_uri).then((validate) => {
            if (!validate(event)) {
                throw new EventInvalidError(this.schema_uri(event, false), validate.errors);
            }
            return event;
        });
    }
}




// var j = '{"comment": "hi", "database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schema_uri": "mediawiki/revision/create/3", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d = yaml.safeLoad(j)

// var j2 = '{"comment": 123, "database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schema_uri": "mediawiki/revision/create/3", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d2 = yaml.safeLoad(j2)


// var j3 = '{"database": "wikidatawiki", "meta": {"domain": "www.wikidata.org", "dt": "2018-10-04T19:55:40+00:00", "id": "787cb0db-c80f-11e8-a05c-b083fedbd4cc", "request_id": "45a181f8-75b0-4384-9280-6aa1bfd584ad", "schema_uri": "mediawiki/revision/create/2", "topic": "mediawiki.revision-create", "uri": "https://www.wikidata.org/wiki/Q49554458"}, "page_id": 50556884, "page_is_redirect": false, "page_namespace": 0, "page_title": "Q49554458", "parsedcomment": "hihi", "performer": {"user_edit_count": 24302262, "user_groups": ["bot", "ipblock-exempt", "rollbacker", "*", "user", "autoconfirmed"], "user_id": 150965, "user_is_bot": true, "user_registration_dt": "2013-03-10T21:32:08Z", "user_text": "KrBot"}, "rev_content_changed": true, "rev_content_format": "application/json", "rev_content_model": "wikibase-item", "rev_id": 757215609, "rev_len": 1686, "rev_minor_edit": false, "rev_parent_id": 635417582, "rev_sha1": "am7sdjq8125nk47hqpimptovilzs2yv", "rev_timestamp": "2018-10-04T19:55:40Z"}'
// var d3 = yaml.safeLoad(j3);

// var base_uri = 'file:///vagrant/srv/event-schemas/jsonschema/';


// var validator = new EventValidator(base_uri);
// validator.validate(d3).then(e => console.log(e));

// validator.validate(d2).then(e => console.log(e)).catch(e => console.log(e.message, e.errors));




module.exports = {
    EventInvalidError: EventInvalidError,
    EventValidator: EventValidator
}
