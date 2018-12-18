'use strict';

const bunyan = require('bunyan');
const assert = require('assert');

const eventgateModule = require('../../../../lib/factories/wikimedia-eventgate');

const {
    EventInvalidError
} = require('../../../../lib/error');


const logger = bunyan.createLogger({ name: 'test/EventValidator', level: 'fatal' });


describe('wikimedia-eventgate makeMapToErrorEvent', () => {
    const mapToErrorEvent = eventgateModule.makeMapToErrorEvent({
        schema_uri_field: '$schema',
        stream_field: 'meta.stream',
        error_stream: 'test_event_error'
    });

    it('Should make an error event for EventInvalidError', () => {
        const error = new EventInvalidError(
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
        // TODO change these when we have a new draft 7 schema in event-schemas repo
        schema_base_uri: 'test/schemas/',
        schema_uri_field: '$schema',
        stream_field: 'meta.stream',
        stream_config_uri: 'test/schemas/stream-config.test.yaml'
    };


    it('Should make function that ensures events are allows in stream and validates events from schemas URIs', async() => {
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

    it('Should throw an EventInvalidError for invalid event', async() => {
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
            assert(err instanceof EventInvalidError);
            threwError = true;
        }
        if (!threwError) {
            assert.fail(`Event should have have thrown error`);
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
            assert.fail(`Event should have have thrown error`);
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
            assert.fail(`Event should have have thrown error`);
        }
    });
});
