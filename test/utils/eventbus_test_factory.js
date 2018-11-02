'use strict';

const _ = require('lodash');
const P = require('bluebird');

const {
    makeExtractTopic,
    makeExtractPartition,
    makeExtractKey,
    makeValidate
} = require('../../lib/factories/default-eventbus');

const EventInvalidError = require('../../lib/error').EventInvalidError;
const Eventbus = require('../../lib/eventbus').Eventbus;

const eUtil = require('../../lib/event-util');

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
 * @param {Object} options
 * @return {function(*=): *}
 */
function makeMockProduce(options) {

    // If an extracted topic contains this string,
    // an Error will be thrown.  This can be used to test
    // upstream Eventbus error handling.
    const unproducableErrorEventTopic = '__throw_unproduceable_error__';
    const producableErrorEventTopic = '__throw_produceable_error__';

    // Create new functions that use static configuration
    // to extract Kafka produce() params from an event.
    const extractTopic      = makeExtractTopic(options);
    const extractPartition  = makeExtractPartition(options);
    const extractKey        = makeExtractKey(options);

    return (event) => {
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

        const partition = extractPartition ? extractPartition(event) : undefined;
        const key = extractKey ? extractKey(event): undefined;

        return P.resolve([
            {
                topic,
                partition,
                offset: 1,
                key,
                opaque: { },
                timestamp: 1539629252472,
                size: JSON.stringify(event).length
            }
        ]);
    };
}


function makeMapToErrorEvent(options) {
    return (error, event) => {
        const eventError = {
            '$schema': options.error_schema_uri,
            meta: {
                topic: options.error_stream,
                // TODO:
                id: '12345'
            },
            emitter_id: 'eventbus_test',  // TODO: ?
            raw_event: _.isString(event) ? event : JSON.stringify(event)
        };

        // TODO: How to test that some get error-produced and some don't?
        if (error instanceof EventInvalidError || error instanceof MockErrorEventProducableError) {
            eventError.message = error.errorsText;
        } else if (error instanceof MockErrorEventUnproducableError) {
            // By returning null, we ensure that this error will not
            // be produced by Eventbus to the event error topic.
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


function mockEventbusFactory(options, logger) {
    return P.resolve(
        new Eventbus({
            validate: makeValidate(options, logger),
            produce: makeMockProduce(options),
            eventRepr: event => 'TEST EVENT',
            log: logger,
            mapToEventError: makeMapToErrorEvent(options)
        })
    );
}

module.exports = {
    factory: mockEventbusFactory
};
