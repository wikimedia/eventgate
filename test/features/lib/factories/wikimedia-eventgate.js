'use strict';

const bunyan = require('bunyan');
const assert = require('assert');
const P = require('bluebird');

const eventgateModule = require('../../../../lib/factories/wikimedia-eventgate');

const {
    ValidationError
} = require('../../../../lib/error');

const logger = bunyan.createLogger({ name: 'test/EventValidator', level: 'fatal' });


describe('wikimedia-eventgate makeMapToErrorEvent', () => {
    const mapToErrorEvent = eventgateModule.makeMapToErrorEvent({
        schema_uri_field: '$schema',
        stream_field: 'meta.stream',
        error_stream: 'test_event_error'
    });

    it('Should make an error event for ValidationError', () => {
        const error = new ValidationError(
            'was invalid',
            [{ dataPath: '.bad.field', message: 'what a bad field' }]
        );
        const event = {
            bad: {
                field: 'a bad field'
            }
        };

        const expected_raw_event = JSON.stringify(event);
        const expected_error_message = error.errorsText;

        const errorEvent = mapToErrorEvent(error, event);

        assert.strictEqual(errorEvent.raw_event, expected_raw_event);
        assert.strictEqual(errorEvent.message, expected_error_message);
        assert.strictEqual(errorEvent.meta.stream, 'test_event_error');
    });

    it('Should return null for a regular Error', () => {
        const mapToErrorEvent = eventgateModule.makeMapToErrorEvent({
            schema_uri_field: '$schema',
            stream_field: 'meta.stream',
        });

        const error = new Error("shouldn't matter");
        const event = {
            bad: {
                field: 'a bad field'
            }
        };

        const errorEvent = mapToErrorEvent(error, event);
        assert.strictEqual(errorEvent, null);
    });
});


describe('wikimedia-eventgate makeExtractStream', () => {
    it('Should make function that extracts stream name', () => {
        const extractStream = eventgateModule.makeExtractStream({
            schema_uri_field: '$schema',
            stream_field: 'meta.stream'
        });

        const event0 = { name: 'event0', meta: { stream: 'cool_stream' } };
        const event1 = { name: 'event1', meta: { } };

        assert.equal(extractStream(event0), 'cool_stream');
        assert.throws(() => {
            extractStream(event1);
        });
    });
});

describe('wikimedia-eventgate makeExtractTopic', () => {
    it('Should make function that extracts stream name', () => {
        const extractStream = eventgateModule.makeExtractStream({
            schema_uri_field: '$schema',
            stream_field: 'meta.stream'
        });

        const event0 = { name: 'event0', meta: { stream: 'cool_stream' } };
        const event1 = { name: 'event1', meta: { } };

        assert.equal(extractStream(event0), 'cool_stream');
        assert.throws(() => {
            extractStream(event1);
        });
    });
});


describe('wikimedia-eventgate makeWikimediaValidate', () => {

    const options = {
        schema_base_uris: 'test/schemas/',
        schema_uri_field: '$schema',
        stream_field: 'meta.stream',
        stream_config_uri: 'test/schemas/stream-config.test.yaml'
    };

    // No stream_config_uri is set here, so any $schema will be
    // allowed in any stream.
    const permissiveOptions = {
        schema_base_uris: 'test/schemas/',
        schema_uri_field: '$schema',
        stream_field: 'meta.stream',
    };


    it('Should make function that ensures events are allowed in stream and validates events from schemas URIs', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        const testEvent_v1_0 = {
            '$schema': '/test/0.0.1',
            meta: {
                stream: 'test.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
            },
            test: 'test_value_0'
        };

        const validEvent = await validate(testEvent_v1_0);
        assert.deepEqual(validEvent, testEvent_v1_0);
    });

    it('Should make function that ensures events are allowed in stream config regex', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        // This event should pass via regex checking in stream config
        const testEvent_draft4 = {
            '$schema': '/test_draft4/0.0.1',
            meta: {
                stream: 'test_draft4.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
            },
            test: 'test_value_0'
        };

        const validEvent = await validate(testEvent_draft4);
        assert.deepEqual(validEvent, testEvent_draft4);
    });

    it('Should make function that allows any schema in any stream with no stream_config_uri set', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(permissiveOptions, logger);

        // This event should pass via regex checking in stream config
        const testEvent_draft4 = {
            '$schema': '/test_draft4/0.0.1',
            meta: {
                stream: 'test_draft4.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
            },
            test: 'test_value_0'
        };

        const validEvent = await validate(testEvent_draft4);
        assert.deepEqual(validEvent, testEvent_draft4);
    });


    it('Should throw an ValidationError for invalid event', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        const testInvalidEvent = {
            '$schema': '/test/0.0.1',
            meta: {
                stream: 'test.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
            },
            test: 1234
        };

        let threwError = false;
        try {
            await validate(testInvalidEvent);
        } catch (err) {
            assert(err instanceof ValidationError);
            threwError = true;
        }
        if (!threwError) {
            assert.fail(`Event validation should have have thrown ValidationError`);
        }
    });

    it('Should throw an error for an event that is not allowed in a stream', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        const testUnallowedEvent = {
            '$schema': '/error/0.0.1',
            meta: {
                stream: 'test.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
            },
            test: 'test_value_0'
        };

        let threwError = false;
        try {
            await validate(testUnallowedEvent);
        } catch (err) {
            assert(err instanceof eventgateModule.UnauthorizedSchemaForStreamError);
            threwError = true;
        }
        if (!threwError) {
            assert.fail(`Event validation should have have thrown UnauthorizedSchemaForStreamError`);
        }
    });

    it('Should throw an error for an event that is not allowed in a regex stream', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        const testUnallowedEvent = {
            '$schema': '/error/0.0.1',
            meta: {
                stream: 'test_draft4.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
            },
            test: 'test_value_0'
        };

        let threwError = false;
        try {
            await validate(testUnallowedEvent);
        } catch (err) {
            assert(err instanceof eventgateModule.UnauthorizedSchemaForStreamError);
            threwError = true;
        }
        if (!threwError) {
            assert.fail(`Event validation should have have thrown UnauthorizedSchemaForStreamError`);
        }
    });

    it('Should throw an error for an event that does not have a stream in stream config', async() => {
        const validate = await eventgateModule.makeWikimediaValidate(options, logger);

        const testUnconfiguredStreamEvent = {
            '$schema': '/test/0.0.1',
            meta: {
                stream: 'nope.test.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1289',
            },
            test: 'test_value_0'
        };

        let threwError = false;
        try {
            await validate(testUnconfiguredStreamEvent);
        } catch (err) {
            assert(err instanceof eventgateModule.UnauthorizedSchemaForStreamError);
            threwError = true;
        }
        if (!threwError) {
            assert.fail(`Event validation should have have thrown UnauthorizedSchemaForStreamError`);
        }
    });
});


describe('wikimedia-eventgate makeProduce', () => {

    const options = {
        stream_field: 'meta.stream',
        topic_prefix: 'test_it.',
    };

    it('Should make a function that uses varies Kafka producer based on req.query fire and forget param and topic_prefix', async() => {

        function mockProduceFunction(producerName, topic, partition, message, key) {
            return P.resolve([{
                topic,
                partition: 0,
                offset: 1,
                key: key,
                opaque: { },
                timestamp: 1539629252472,
                size: message.length,
                producerName
            }]);
        };

        const mockGuaranteedKafkaProducer = {
            produce: mockProduceFunction.bind(null, 'guaranteedProducer')
        };
        const mockHastyKafkaProducer = {
            produce: mockProduceFunction.bind(null, 'hastyProducer')
        };

        const produce = eventgateModule.makeProduce(
            options, mockGuaranteedKafkaProducer, mockHastyKafkaProducer
        );

        const testEvent_v1_0 = {
            '$schema': '/test/0.0.1',
            meta: {
                stream: 'test.event',
                id: '5e1dd101-641c-11e8-ab6c-b083fecf1287',
            },
            test: 'test_value_0'
        };

        const guaranteedProduceResult = await produce(
            testEvent_v1_0, { req: { query: { hasty: false } } }
        );
        assert.strictEqual(guaranteedProduceResult[0].producerName, 'guaranteedProducer');
        assert.strictEqual(guaranteedProduceResult[0].topic, 'test_it.test.event');

        const hastyProduceResult = await produce(
            testEvent_v1_0, { req: { query: { hasty: true } } }
        );
        assert.strictEqual(hastyProduceResult[0].producerName, 'hastyProducer');
        assert.strictEqual(hastyProduceResult[0].topic, 'test_it.test.event');
    });
})
