'use strict';

/**
 * Should be thrown when an event fails schema validation.
 * This is caught by EventGate to classify event process status.
 */
class EventInvalidError extends Error {
    /**
     * @param {string} message about what caused the invalid error
     * @param {Array} errors AJV errors that caused event validation to fail
     */
    constructor(message, errors) {
        super(message);
        this.errors = errors;
        this.errorsText = errors.map(err => `'${err.dataPath}' ${err.message}`).join(', ');
    }
}

/**
 * Thrown if an event's schema cannot be loaded.
 */
class EventSchemaLoadError extends Error {}

/**
 * Thrown if a schema URI cannot be extracted from an event.
 */
class EventSchemaUriMissingError extends Error {}

/**
 * Thrown by the event-utils objectGet function.
 */
class PropertyNotFoundError extends Error {}


module.exports = {
    EventInvalidError,
    EventSchemaLoadError,
    EventSchemaUriMissingError,
    PropertyNotFoundError
};
