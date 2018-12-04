'use strict';

const _        = require('lodash');
const P        = require('bluebird');
const yaml     = require('js-yaml');
const readFile = P.promisify(require('fs').readFile);
const preq     = require('preq');
const basename = require('path').basename;
const { URL }  = require('url');
const path     = require('path');

const {
    PropertyNotFoundError
} = require('./error');


/**
 * Converts a utf-8 byte buffer or a YAML/JSON string into
 * an object and returns it.
 * @param {string|Buffer|Object} data
 */
function objectFactory(data) {
    // If we were given a byte Buffer, parse it as utf-8 string.
    if (data instanceof Buffer) {
        data = data.toString('utf-8');
    } else if (_.isObject(data)) {
        // if we were given a a JS object, return it now.
        return data;
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


/**
 * A wrapper around lodash.get that throws PropertyNotFoundError
 * if no default value was given, and lodash.get returns undefined.
 * @param {Object} object
 * @param {string} path
 * @param {any} defaultValue
 * @return {any}
 * @throws {PropertyNotFoundError} if Object does not have path and no default given.
 */
function objectGet(object, path, defaultValue) {
    const value = _.get(object, path, defaultValue);
    if (_.isUndefined(value)) {
        throw new PropertyNotFoundError(
            `Property '${path}' not found in object`, object
        );
    }
    return value;
}

// https://tools.ietf.org/html/rfc3986#section-3.1
const uriProtocolRegex = /^[a-zA-Z0-9+.-]+:\/\//;
/**
 * Returns true if the uri has protocol schema on the front, else false.
 * @param {string} uri
 * @return {boolean}
 */
function uriHasProtocol(uri) {
    return uriProtocolRegex.test(uri);
}

/**
 * Given a string URL, returns a Promise of the contents at that
 * URL.  Supports both file:// (via fs.readFile) and other http
 * based URLs with preq.get.
 * @param {string} url
 * @return {Promise<string>}
 */
function urlGet(url) {
    if (!uriHasProtocol(url)) {
        // assume this is a local file path
        return readFile(url);
    } else if (url.startsWith('file://')) {
        // still a local file path,
        // parse url to get protocol less path for use with readFile
        return readFile(new URL(url).pathname);
    } else {
        // else this is not a local file path, use remote request.
        return preq.get({ uri: url }).then(res => res.body);
    }
}

/**
 * Given a URL, returns a Promise of the contents at that
 * converted into an Object.  The content at URL
 * must either be a JSON or YAML string.
 * @param {string} url
 */
function urlGetObject(url) {
    return urlGet(url).then(content => objectFactory(content));
}

/**
 * Returns the file extension (or the last part after a final '.' in a file basename)
 * of a filename path. If no file extension is present, this returns an empty string.
 * If the final part of a file name after '.' is numeric, this is not a file
 * extension, and an empty string will be returned.
 * @param {string} filename
 * @return {string}
 */
function fileExtension(filename) {
    if (!filename) {
        return '';
    }

    const parts = basename(filename).split('.');
    if (parts.length > 1 && isNaN(parts[parts.length - 1])) {
        return parts[parts.length - 1];
    } else {
        return '';
    }
}

/**
 * Takes a possibly relative uri, and augments it so that it is better suited for use in requests.
 * If the uri is already qualified (e.g. is starts with a protocol scheme), baseUri will
 * not be prepended.
 * If the uri already ends in a file extensions, defaultFileExtension  will not be appended.
 * If the baseUri given does not have a protocol schema, it is assumed to be file://.
 * file:// paths will be resolved with path.resolve to be transformed into absolute file paths.
 * @param {string} uri
 *      uri to resolve with baseUri and defaultFileExtension
 * @param {string} baseUri
 *      If given, non uris that don't start with a protocol scheme will be prepended with this.
 * @param {string} defaultFileExtension
 *      If given, uris that don't end with a file extension will be appended with this.
 */
function resolveUri(uri, baseUri, defaultFileExtension) {
    let url = uri;
    // If uri doesn't already have an extension, and we are given a default one, append it.
    if (!fileExtension(uri) && defaultFileExtension) {
        url = uri + defaultFileExtension;
    }

    // If the uri doesn't have a protocol, then we can use
    // the given baseUri as the default.
    if (baseUri && !uriHasProtocol(url)) {
        url = baseUri + url;
    }

    // If the url still doesn't have a protocol, assume it should be file://.
    if (!uriHasProtocol(url)) {
        url = `file://${path.resolve(url)}`;
    }
    return url;
}

/**
 * Given an event, extracts and returns a new URL
 * @param {string} uriField field path in event to extract URI
 * @param {string} baseUri If given, this will be prefixed to the extracted URI
 * @param {string} defaultFileExtension If the basename of the URI does not end
 *                 in a file extension, this will be appended to the URI.
 * @param {Object} event The event to extract a URL from.
 * @return {string} of the extracted URL
 */
function extractUrl(uriField, baseUri, defaultFileExtension, event) {
    const uri = objectGet(event, uriField);
    return resolveUri(uri, baseUri, defaultFileExtension);
}


module.exports = {
    objectFactory,
    objectGet,
    urlGet,
    urlGetObject,
    fileExtension,
    extractUrl,
    resolveUri,
    uriHasProtocol
};
