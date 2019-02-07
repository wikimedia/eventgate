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

/**
 * Given an array of paths, this searches the object for the first
 * defined path and returns it using objectGet.
 * @param {Object} object
 * @param {Array|string} paths
 * @param {any} defaultValue
 * @return {any}
 * @throws {PropertyNotFoundError} if Object does not have any path
 */
function objectFindAndGet(object, paths, defaultValue) {
    paths = _.isArray(paths) ? paths : [paths];
    const foundPath = paths.find(f => _.has(object, f));
    if (_.isUndefined(foundPath)) {
        throw new PropertyNotFoundError(
            `None of '${paths}' were found in object`, object
        );
    }
    return objectGet(object, foundPath, defaultValue);
}

/**
 * Returns true if subject matches pattern.  If pattern is
 * a RegExp or looks like one (starts and ends with /), then
 * it will be tested against subject. Otherwise subject === pattern.
 * @param {string} subject
 * @param {string|RegExp} pattern
 */
function stringMatches(subject, pattern) {
    if (pattern instanceof RegExp) {
        return pattern.test(subject);
    } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
        return new RegExp(pattern.substring(1, pattern.length - 1)).test(subject);
    } else {
        return subject === pattern;
    }
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
 *      If given, uris that don't start with a protocol scheme will be prepended with this.
 * @param {string} defaultFileExtension
 *      If given, uris that don't end with a file extension will be appended with this.
 * @return {Promise<Object>}
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
 * @return {Promise<Object>}
 */
function urlGetObject(url) {
    return urlGet(url)
        .then(content => objectFactory(content));
}

/**
 * Given a list of URLs, returns a Promise of the first resolved
 * result of urlGetObject. If no URL resolves, this will return
 * the final rejection.
 * @param {Array<string>} urls
 * @return {Promise<Object>}
 */
function urlGetFirstObject(urls) {
    if (!_.isArray(urls)) {
        urls = [urls];
    }

    // This is a 'fold' like operation on urls, keeping only
    // the first urlGetObject(url) to resolve.
    return urls.reduce((promise, url) => {
        return promise.catch(() => urlGetObject(url));
    }, Promise.reject()); // seed the chain with a rejected promise.
}

/**
 * Combines resolveUri and urlGetObjectFirst to return the first
 * baseUri + uri combination that resolves to an object.
 * @param {string} uri
 *      uri to resolve with baseUri and defaultFileExtension
 * @param {Array<string>} baseUris
 *      If given, uris that don't start with a protocol scheme will be prepended with these.
 * @param {string} defaultFileExtension
 *      If given, uris that don't end with a file extension will be appended with this.
 * @return {Promise<Object>}
 */
function uriGetFirstObject(uri, baseUris, defaultFileExtension) {
    if (!_.isArray(baseUris)) {
        baseUris = [baseUris];
    }

    const urls = _.map(baseUris, (baseUri) => {
        return resolveUri(uri, baseUri, defaultFileExtension);
    });

    return urlGetFirstObject(urls);
}

/**
 * TODO: remove this, it is unused.
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
    objectFindAndGet,
    stringMatches,
    urlGet,
    urlGetObject,
    fileExtension,
    extractUrl,
    resolveUri,
    uriHasProtocol,
    urlGetFirstObject,
    uriGetFirstObject
};
