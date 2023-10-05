'use strict';

const _ = require('lodash');
const P = require('bluebird');

const {
    makeExtractStream,
    makeValidate
} = require('../../lib/factories/default-eventgate');

const ValidationError = require('../../lib/error').ValidationError;
const EventGate = require('../../lib/eventgate').EventGate;

// Errors of this type should be produced as error events.
class MockErrorEventProducableError extends Error {}

// Errors of this type should NOT be produced as error events.
class MockErrorEventUnproducableError extends Error {}

/**
 * Returns a mock produce function that returns a result
 * similar to what node-rdkafka's KafkaProducer produce returns
 * in a delivery callback.  Used for testing only!
 *
 * This function uses options to extract details from an incoming event.
 *
 * @param {Object} options
 * @return {function(*=): *}
 */
function makeMockProduce(options) {

    // If an extracted topic contains this string,
    // an Error will be thrown.  This can be used to test
    // upstream EventGate error handling.
    const unproducableErrorEventTopic = '__throw_unproduceable_error__';
    const producableErrorEventTopic = '__throw_produceable_error__';

    // Use the extracted event stream_name as the topic
    const extractTopic      = makeExtractStream(options);

    return (event, context) => {
        const topic = extractTopic(event);

        if (topic.includes(unproducableErrorEventTopic)) {
            throw new MockErrorEventUnproducableError(
                `Event's topic was ${topic}. This error should be handled, ` +
                'but not produced as an error event'
            );
        }
        if (topic.includes(producableErrorEventTopic)) {
            throw new MockErrorEventProducableError(
                `Event's topic was ${topic}. This error should be handled, ` +
                'and should be produced as an error event'
            );
        }

        return P.resolve([
            {
                topic,
                partition: 0,
                offset: 1,
                key: undefined,
                opaque: { },
                timestamp: 1539629252472,
                size: JSON.stringify(event).length
            }
        ]);
    };
}

function makeMapToErrorEvent(options) {
    return (error, event, context = {}) => {
        const eventError = {
            '$schema': options.error_schema_uri,
            meta: {
                stream_name: options.error_stream,
                id:         'ea262403-f707-11e8-a892-c2baac54c6bc',
                dt:         '2018-12-03T14:30:00.000Z'
            },
            raw_event: _.isString(event) ? event : JSON.stringify(event)
        };

        // TODO: How to test that some get error-produced and some don't?
        if (error instanceof ValidationError || error instanceof MockErrorEventProducableError) {
            eventError.message = error.errorsText;
        } else if (error instanceof MockErrorEventUnproducableError) {
            // By returning null, we ensure that this error will not
            // be produced by EventGate to the event error topic.
            return null;
        } else if (_.isError(error)) {
            eventError.message = error.message;
            eventError.stack = error.stack;
        } else {
            eventError.message = error;
        }

        return eventError;
    };
}


function mockEventGateFactory(options, logger) {
    return P.resolve(
        new EventGate({
            validate: makeValidate(options, logger),
            produce: makeMockProduce(options),
            eventRepr: (event) => 'TEST EVENT',
            log: logger,
            mapToEventError: makeMapToErrorEvent(options)
        })
    );
}

module.exports = {
    factory: mockEventGateFactory,
    makeMockProduce
};
