'use strict';


const _        = require('lodash');
const P        = require('bluebird');
const yaml     = require('js-yaml');
const readFile = P.promisify(require('fs').readFile);
const preq     = require('preq');
const { URL }  = require('url');
const basename = require('path').basename;


/**
 * Converts a utf-8 byte buffer or a YAML/JSON string into
 * an object and returns it.
 */
function objectFactory(data) {
    // if we are given a a JS object, return it now.
    if (_.isObject(data)) {
        return data;
    }

    // If we are given a byte Buffer, parse it as utf-8
    if (data instanceof Buffer) {
        data = data.toString('utf-8');
    }

    // If we now have a string, then assume it is a YAML/JSON string.
    if (_.isString(data)) {
        data = yaml.safeLoad(data);
    } else {
        throw new Error(
            'Could not convert data into an object.  ' +
            'Data must be a utf-8 byte buffer or a YAML/JSON string'
        );
    }

    return data;
}


class PropertyNotFoundError extends Error {}

/**
 * Given an object and a dotted path string, extracts
 * the value in the object at path.  Example:
 *
 * object = {prop1: 'yes', prop2: { sub1: { my_value: 'got me' } } };
 * path   = 'prop2.sub1.myvalue'
 * objectProperty(object, path)
 * // returns 'got me'
 *
 * This does not support objects that have dots in their property names, e.g.
 * { 'dotted.property.name': 'value' } cannot be extracted.
 * @param {string} path
 * @param {Object} object
 * @throws PropertyNotFoundError if the path cannot be found in object.
 */
function objectProperty(path, object) {
    return path.split('.').reduce((current, key) => {
        if (!_.has(current, key)) {
            throw new PropertyNotFoundError(`Property '${path}' not found in object`);
        }
        return current[key];
    }, object);
}


/**
 * Given a URL, returns a Promise of the contents at that
 * URL.  Supports both file:// (via fs.readFile) and other http
 * based URLs with preq.get.
 */
function urlGet(url) {
    if (_.isString(url)) {
        url = new URL(url);
    }

    if (url.protocol === 'file:') {
        return readFile(url.pathname, 'utf-8');
    } else {
        return preq.get({ uri: url.href }).then(res => res.body);
    }
}


/**
 * Given a URL, returns a Promise of the contents at that
 * converted into a JS object.  The content at URL
 * must either be a JSON or YAML string.
 */
function urlGetObject(url) {
    return urlGet(url).then(content => objectFactory(content));
}

/**
 * Returns the file extension (or the last part after a final '.' in a file basename)
 * of a filename path.
 */
function fileExtension(filename) {
    if (!filename) {
        return '';
    }

    const parts = basename(filename).split('.');
    if (parts.length > 1) {
        return parts[parts.length - 1];
    } else {
        return '';
    }
}


// event -> schema_uri field
// event -> FULL schema_url
// event -> topic

// topic -> schema?  from config??

function getSchemaUri(schemaField, event) {
    return objectProperty(schemaField, event);
}

// Do we need topicField here?!?
function getSchemaUrl(schemaField, baseSchemaUri, defaultFileExtension, event) {
    let uri = getSchemaUri(schemaField, event);

    // If schema uri doesn't already have an extension, and we are given a default one, append it.
    if (!fileExtension(uri) && defaultFileExtension) {
        uri += defaultFileExtension;
    }

    // Join uri with baseUri if given baseSchemaUri
    if (baseSchemaUri) {
        // New URL with base uri needs to end with / or the end of the
        // directory path will not be used!
        if (!_.endsWith(baseSchemaUri, '/')) {
            baseSchemaUri += '/';
        }

        return new URL(uri, baseSchemaUri).href;
    } else {
        return uri;
    }

}

// function getSchemaUriByTopic(topic, topicSchemaConfig) {

// }

function getTopic(topicField, topicTransformFn, event) {
    let topic = objectProperty(topicField, event);
    if (topicTransformFn) {
        topic = topicTransformFn(topic);
    }

    return topic;
}


module.exports = {
    objectFactory,
    PropertyNotFoundError,
    objectProperty,
    urlGet,
    urlGetObject,
    fileExtension,
    getSchemaUri,
    getSchemaUrl,
    getTopic
};
