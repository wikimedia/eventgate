'use strict';

const _        = require('lodash');

const {
    PropertyNotFoundError,
    MissingFieldError,
} = require('./error');

/**
 * A wrapper around lodash.get that throws PropertyNotFoundError
 * if no default value was given, and lodash.get returns undefined.
 *
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
 *
 * @param {Object} object
 * @param {Array|string} paths
 * @param {any} defaultValue
 * @return {any}
 * @throws {PropertyNotFoundError} if Object does not have any path
 */
function objectFindAndGet(object, paths, defaultValue) {
    paths = _.isArray(paths) ? paths : [paths];
    const foundPath = paths.find((f) => _.has(object, f));
    if (_.isUndefined(foundPath)) {
        throw new PropertyNotFoundError(
            `None of '${paths}' were found in object`, object
        );
    }
    return objectGet(object, foundPath, defaultValue);
}

/**
 * Returns a function that calls objectFindAndGet and throws
 * an event specific error if the field(s) is missing.
 *
 * @param {Array|string} field path (or paths) to look for in event
 * @param {any} defaultValue
 * @return {function(Object, Object): any}
 */
function makeExtractField(field, defaultValue) {
    if (_.isUndefined(field)) {
        throw new Error('Must provide a field to extract.');
    }

    return (event, context = {}) => {
        try {
            return objectFindAndGet(event, field, defaultValue);
        } catch (err) {
            // Wrap PropertyNotFoundError in a new specific Error about missing event field.
            if (err instanceof PropertyNotFoundError) {
                throw new MissingFieldError(
                    `Field(s) ${field} were missing from event and could not be extracted.`
                );
            } else {
                throw err;
            }
        }
    };
}

/**
 * Returns true if subject matches pattern.  If pattern is
 * a RegExp or looks like one (starts and ends with /), then
 * it will be tested against subject. Otherwise subject === pattern.
 *
 * @param {string} subject
 * @param {string|RegExp} pattern
 * @return {boolean}
 */
function stringMatches(subject, pattern) {
    if (pattern instanceof RegExp) {
        return pattern.test(subject);
    } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
        return new RegExp(pattern.slice(1, pattern.length - 1)).test(subject);
    } else {
        return subject === pattern;
    }
}

module.exports = {
    objectGet,
    objectFindAndGet,
    makeExtractField,
    stringMatches
};
