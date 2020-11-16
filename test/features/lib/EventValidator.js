'use strict';

const bunyan            = require('bunyan');
const assert            = require('assert');

const {
    resolveUri,
    urlGetObject,
} = require('@wikimedia/url-get');

const EventValidator    = require('../../../lib/EventValidator');
const {
    EventSchemaLoadError,
    ValidationError
} = require('../../../lib/error');

const schemaUri = '/test/0.0.1';
const baseSchemaUri = './test/schemas';
const logger = bunyan.createLogger({ name: 'test/EventValidator', level: 'fatal' });

const testEvent_v1_0 = {
    '$schema': '/test/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
    },
    test: 'test_value_0'
};
const testEvent_v1_1 = {
    '$schema': '/test/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1288',
    },
    test: 'test_value_1'
};
const testInvalidEvent = {
    '$schema': '/test/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
    },
    test: 1234
};

const testEvent_v2_0 = {
    '$schema': '/test/0.0.2',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1290',
    },
    test: 'test_value_0'
};

const testEvent_draft4 = {
    '$schema': '/test_draft4/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1290',
    },
    test: 'test_value_0'
};

const testEvent_draft6 = {
    '$schema': '/test_draft6/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1290',
    },
    test: 'test_value_0'
};

const testEvent_insecure = {
    '$schema': '/test_insecure/0.0.1',
    meta: {
        stream: 'test.event',
        id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
    },
    test: 'test_value_0'
};

function extractSchemaUri(event) {
    return event.$schema;
}

function getSchema(uri) {
    const url = resolveUri(uri, baseSchemaUri);
    return urlGetObject(url);
}

/**
 * Returns a Promise of the loaded test schema.  Used in tests.
 */
function loadTestSchema() {
    return urlGetObject(resolveUri(schemaUri, baseSchemaUri));
}

describe('EventValidator test instance', () => {
    const eventValidator = new EventValidator({
        extractSchemaUri,
        getSchema,
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
            assert(false, "ValidationError should have been thrown");
        } catch (err) {
            assert(err instanceof ValidationError);
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

    it('should validate an event with a draft-04 jsonschema, using locally loaded meta schema from ajv', async() => {
        // This test will cause the draft-04 meta schema that was added by the default
        // options.metaSchemas to be used.
        const schema = await eventValidator.schemaFor(testEvent_draft4);
        const metaSchemaUri = schema.$schema;
        const metaSchema = eventValidator.ajv.getSchema(metaSchemaUri).schema;
        assert.strictEqual('http://json-schema.org/draft-04/schema#', eventValidator.ajv._getId(metaSchema));
    });

    it('should validate an event with a draft-06 jsonschema, using remote loaded meta schema from json-schema.org', async() => {
        // This test will cause the draft-06 meta schema to be requested from json-schema.org,
        // since the draft-06 schema isn't added in options.metaSchemas.
        const schema = await eventValidator.schemaFor(testEvent_draft6);
        const metaSchemaUri = schema.$schema;
        const metaSchema = eventValidator.ajv.getSchema(metaSchemaUri).schema;
        assert.strictEqual('http://json-schema.org/draft-06/schema#', eventValidator.ajv._getId(metaSchema));
    });

    it('should fail validation of an event that uses an insecure schema', async() => {
        try {
            await eventValidator.validate(testEvent_insecure);
            assert(false, "ValidationError should have been thrown");
        } catch (err) {
            assert(err instanceof EventSchemaLoadError);
        }
    });

    it('should pass validation of an event that uses an insecure schema with allowInsecureSchema: true', async() => {
        const insecureEventValidator = new EventValidator({
            extractSchemaUri,
            getSchema,
            log: logger,
            allowInsecureSchemas: true
        });

        const event = await insecureEventValidator.validate(testEvent_insecure);
        assert.deepEqual(testEvent_insecure, event);
    });

    it('2 EventValidator instances should not conflict', async() => {
        // There was a bug in EventValidator constructor where
        // _.defaults was assigning an incorrect loadSchema function
        // to ajv.  This test ensures that doesn't happen again.

        const ev1 = new EventValidator({
            extractSchemaUri,
            getSchema,
            log: logger
        });

        const ev2 = new EventValidator({
            extractSchemaUri,
            getSchema,
            log: logger
        });

        const e1 = await eventValidator.validate(testEvent_draft4);
        const e2 = await eventValidator.validate(testEvent_draft4);

        assert.deepEqual(e1, e2);
    });

});
