'use strict';

const _        = require('lodash');
const P        = require('bluebird');

const initUtils = require('../../lib/eventbus-factory-utils');
const EventValidator = require('../../lib/validator').EventValidator;
const EventInvalidError = require('../../lib/validator').EventInvalidError;
const Eventbus = require('../../lib/eventbus').Eventbus;

/**
 * Returns a mock produce function that returns a result
 * similar to what node-rdkafka's KafkaProducer produce returns
 * in a delivery callback.  Used for testing only!
 *
 * This function uses app.conf to extract details from an incoming event.
 * @param {Object} conf
 * @return {function(*=): *}
 */
function createMockProduceFunction(conf) {

    // If an extracted topic contains this string,
    // an Error will be thrown.  This can be used to test
    // upstream Eventbus error handling.
    const throwErrorIfTopic = '__throw_error__';

    // Create new functions that use static configuration
    // to extract Kafka produce() params from an event.
    const extractTopic = initUtils.createExtractTopicFunction(conf);
    const extractPartition = initUtils.createExtractPartitionFunction(conf);
    const extractKey = initUtils.createExtractKeyFunction(conf);

    return (event) => {
        const topic = extractTopic(event);


        if (topic.includes(throwErrorIfTopic)) {
            throw new Error(`Event's topic was ${topic}. This error should be handled!`);
        }

        const partition = extractPartition(event);
        const key = extractKey(event);

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


function createMockErrorEventFunction(conf) {
    return (error, event) => {
        const eventError = {
            '$schema': conf.error_schema_uri,
            meta: {
                topic: conf.error_stream,
                // TODO:
                id: '12345'
            },
            emitter_id: 'eventbus_test',  // TODO: ?
            raw_event: _.isString(event) ? event : JSON.stringify(event)
        };

        if (error instanceof EventInvalidError) {
            eventError.message = error.errorsText;
        } else if (_.isError(error)) {
            eventError.message = error.message;
            eventError.stack = error.stack;
        } else {
            eventError.message = error;
        }

        return eventError;
    };
}

function createMockEventbus(conf, logger) {

    const eventValidator = EventValidator.createFromConf(conf, logger);

    return P.resolve(
        new Eventbus(
            eventValidator.validate.bind(eventValidator),
            createMockProduceFunction(conf),
            initUtils.createEventReprFunction(conf),
            logger,
            createMockErrorEventFunction(conf)
        )
    );
}

module.exports = (conf, logger) => {
    return createMockEventbus(conf, logger);
};
