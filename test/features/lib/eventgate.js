'use strict';

const bunyan            = require('bunyan');
const P = require('bluebird');
const assert = require('assert');
const {
    EventGate,
    EventStatus
} = require('../../../lib/eventgate');

const ValidationError = require('../../../lib/error').ValidationError;

const logger = bunyan.createLogger({ name: 'test/EventValidator', level: 'fatal' });

describe('EventStatus', () => {
    it('Should throw error if constructed with unknown status', () => {
        assert.throws(() => {
            new EventStatus('nopers', {}, {});
        });
    });

    it('Should have error as EventStatus context', () => {
        const error = new Error("error message here");
        const eventStatus = new EventStatus('error', error, {});
        assert.deepEqual(error, eventStatus.context);
    });

    it('Should serialize generic error EventStatus without extra info', () => {
        const error = new Error("error message here");
        const eventStatus = new EventStatus('error', error, {});
        const eventStatusSerialized = eventStatus.toJSON();

        assert.equal(eventStatus.status, eventStatusSerialized.status);
        assert.equal(eventStatus.event, eventStatusSerialized.event);
        assert.deepEqual({ message: error.message }, eventStatusSerialized.context);
    });

    it('Should serialize ValidationError EventStatus with full context', () => {
        const error = new ValidationError("error message here", [
            {
                dataPath: '.path.to.field',
                message: 'that was a nasty field',
            }
        ]);
        const eventStatus = new EventStatus('error', error, {});
        const eventStatusSerialized = eventStatus.toJSON();
        assert.deepEqual(error, eventStatusSerialized.context);
    });
});


describe('EventGate', () => {
    const events = [
        { fake: 'event0' },
        { fake: 'event1' }
    ];
    
    const successContext = {
        validateStatus: 'success',
        produceStatus: 'success'
    };

    const invalidContext = {
        validateStatus: 'invalid',
        produceStatus: 'success'
    };

    const failedValidateContext = {
        validateStatus: 'error',
        produceStatus: 'success'
    };

    const failedProduceContext = {
        validateStatus: 'success',
        produceStatus: 'error'
    };

    // mapToErrorEvent will push events into producedErrorEvents.
    // Clear them out after each test.
    let producedErrorEvents = [];
    beforeEach(() => {
        producedErrorEvents = [];
    });

    const mockEventGate = new EventGate({

        log: logger,

        validate: (event, context) => {
            if (context.validateStatus == 'success') {
                return P.resolve(event);
            } else if (context.validateStatus == 'invalid') {
                throw new ValidationError("invalid event", [
                    {
                        dataPath: '.path.to.field',
                        message: 'that was a nasty field',
                    }
                ]);
            } else {
                throw new Error("event caused an error during validation");
            }
        },

        produce: (event, context) => {
            if (context.produceStatus === 'success') {
                return P.resolve([
                    {
                        status: 'success'
                    }
                ]);
            } else {
                throw new Error("event caused an error during produce");
            }
        },

        mapToErrorEvent: (error, event, context) => {
            // Only produce error events for ValidationError
            if (!(error instanceof ValidationError)) {
                return null;
            }

            const errorEvent = {
                error,
                original_event: event
            };

            producedErrorEvents.push(errorEvent);
            return errorEvent;
        }
    });

    /**
     * Asserts that count events have been pushed into producedErrorEvents within
     * timeout milliseconds.
     * @param {integer} count
     * @param {integer} timeout
     */
    function assertErrorEventsProduced(count, timeout = 100) {
        // Wait a bit and assert that error events were produced.
        // Error events are produced asynchronously after the original .process() resolves.
        return new P((resolve) => {
            setTimeout(() => {
                assert.equal(producedErrorEvents.length, count,
                    `Should have produced ${count} error events within ${timeout} milliseconds`);
                resolve();
            }, timeout);
        });
    }

    it('Should process throw error if no validate function', async() => {
        assert.throws(() => {
            new EventGate({validate: undefined, produce: (e) => e});
        });
    });

    it('Should process throw error if no produce function', async() => {
        assert.throws(() => {
            new EventGate({validate: (e) => e, produce: undefined});
        });
    });

    it('Should process 2 events', async() => {
        const result = await mockEventGate.process(events, successContext);
        assert.equal(result.success.length, 2);
        assert.equal(result.invalid.length, 0);
        assert.equal(result.error.length,   0);

        return assertErrorEventsProduced(0);

    });

    it('Should process 2 invalid events', async() => {
        const result = await mockEventGate.process(events, invalidContext);
        assert.equal(result.success.length, 0);
        assert.equal(result.invalid.length, 2);
        assert.equal(result.error.length,   0);

        return assertErrorEventsProduced(2);
    });

    it('Should process 2 validation error events', async() => {
        const result = await mockEventGate.process(events, failedValidateContext);
        assert.equal(result.success.length, 0);
        assert.equal(result.invalid.length, 0);
        assert.equal(result.error.length,   2);

        return assertErrorEventsProduced(0);

    });

    it('Should process 2 produce error events', async() => {
        const result = await mockEventGate.process(events, failedProduceContext);
        assert.equal(result.success.length, 0);
        assert.equal(result.invalid.length, 0);
        assert.equal(result.error.length,   2);

        return assertErrorEventsProduced(0);
    });
});
