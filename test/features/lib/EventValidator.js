'use strict';

const bunyan            = require('bunyan');
const assert            = require('assert');
const eUtil             = require('../../../lib/event-util');
const EventValidator    = require('../../../lib/EventValidator');
const EventInvalidError = require('../../../lib/error').EventInvalidError;

const schemaUri = '/test/0.0.1';
const baseSchemaUri = './test/schemas';
const logger = bunyan.createLogger({ name: 'test/EventValidator', level: 'fatal' });

const testEvent_v1_0 = {
    '$schema': '/test/0.0.1',
    meta: {
        stream_name: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
    },
    test: 'test_value_0'
};
const testEvent_v1_1 = {
    '$schema': '/test/0.0.1',
    meta: {
        stream_name: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1288',
    },
    test: 'test_value_1'
};
const testInvalidEvent = {
    '$schema': '/test/0.0.1',
    meta: {
        stream_name: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
    },
    test: 1234
};

const testEvent_v2_0 = {
    '$schema': '/test/0.0.2',
    meta: {
        stream_name: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1290',
    },
    test: 'test_value_0'
};

function extractSchemaUri(event) {
    return event.$schema;
}

function resolveSchemaUri(uri) {
    return eUtil.resolveUri(uri, baseSchemaUri);
}

/**
 * Returns a Promise of the loaded test schema.  Used in tests.
 */
function loadTestSchema() {
    return eUtil.urlGetObject(eUtil.resolveUri(schemaUri, baseSchemaUri));
}

describe('EventValidator test instance', () => {
    const eventValidator = new EventValidator({
        extractSchemaUri,
        resolveSchemaUri,
        log: logger
    });

    it('should pass validation of valid event', async() => {
        const event = await eventValidator.validate(testEvent_v1_0);
        assert.deepEqual(testEvent_v1_0, event);

        // load the test schema for use in test cases
        const testSchema = await loadTestSchema();

        const eventSchema = await eventValidator.schemaFor(event);
        // loaded schema for event should be the same as testSchema.
        assert.deepEqual(testSchema, eventSchema, 'test event schema should be test schema');

        // The default value filled in by validate should be this.
        const testDefaultValue = testSchema.properties.test_default.default;
        assert.equal(testDefaultValue, event.test_default, 'default should be provided by schema');
    });

    it('should fail validation of invalid event', async() => {
        try {
            await eventValidator.validate(testInvalidEvent);
            assert(false, "EventInvalidError should have been thrown");
        } catch (err) {
            assert(err instanceof EventInvalidError);
        }
    });

    it('should return the same validate function for events of same $schema', async() => {
        const validate0 = await eventValidator.validatorFor(testEvent_v1_0);
        const validate1 = await eventValidator.validatorFor(testEvent_v1_1);
        assert.deepStrictEqual(
            validate0, validate1,
            'validate functions should be the same'
        );
    });

    it('should return different validate functions for events of different $schema', async() => {
        const validate0 = await eventValidator.validatorFor(testEvent_v1_0);
        const validate1 = await eventValidator.validatorFor(testEvent_v2_0);
        assert.notDeepStrictEqual(
            validate0, validate1,
            'validate functions should be different'
        );
    });
});
