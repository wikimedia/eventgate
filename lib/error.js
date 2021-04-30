'use strict';

/**
 * Error class that takes extra context object and copies
 * The object's keys to itself.  This makes wrapping
 * Errors easier, via new ContextualError(msg, originalError);
 * This class also sets a property 'name' that matches
 * the classes constructor, so you can more easily see the type of error
 * in logging.
 */
class ContextualError extends Error {
    /**
     * @param {string} message
     * @param {Object} context
     */
    constructor(message, context) {
        super(message);

        // Copy each extra property to this.
        if (context) {
            Object.assign(this, context);
        }

        Object.defineProperty(this, 'name', {
            value: this.constructor.name,
            configurable: true,
            enumerable: false,
            writable: true,
        });
    }
}

/**
 * Should be thrown when an event fails schema validation.
 * This is caught by EventGate to classify event process status.
 */
class ValidationError extends ContextualError {
    /**
     * @param {string} message about what caused the invalid error
     * @param {Array} errors AJV errors that caused event validation to fail
     */
    constructor(message, errors) {
        super(message);
        this.errors = errors;
        this.errorsText = errors.map((err) => `'${err.dataPath}' ${err.message}`).join(', ');
    }
}

/**
 * Thrown if an event's schema cannot be loaded.
 */
class EventSchemaLoadError extends ContextualError {}

/**
 * Thrown if a schema URI cannot be extracted from an event.
 */
class EventSchemaUriMissingError extends ContextualError {}

/**
 * Thrown by the event-utils objectGet function.
 */
class PropertyNotFoundError extends ContextualError {}

/**
 * Thrown by event-utils makeExtractField funciton.
 */
class MissingFieldError extends Error {}

module.exports = {
    ValidationError,
    EventSchemaLoadError,
    EventSchemaUriMissingError,
    PropertyNotFoundError,
    MissingFieldError
};
