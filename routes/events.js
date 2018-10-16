'use strict';


const P = require('bluebird');
const sUtil = require('../lib/util');
// shortcut
// const HTTPError = sUtil.HTTPError;

const _        = require('lodash');

const kafka = require('../lib/kafka');
const eUtil = require('../lib/eventbus-utils');
const {
    EventInvalidError,
    EventValidator
} = require('../lib/validator');


/**
 * The main router object
 */
const router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
let app;


function produceEvent(event, topicField, kafkaProducer) {
    // TODO: support configurable keys / partitioners?
    return kafkaProducer.produce(
        eUtil.getTopic(topicField, null, event),
        undefined,
        Buffer.from(JSON.stringify(event)),
        undefined
    );
}


// TODO: Not sure if this should be a class at all.  Probably not?
class EventError extends Error {
    constructor(error, event, req) {
        super(error.message);
        this.stack = error.stack;
        this.event = {
            meta: {
                schema_uri: 'error/2',
            },
            emitter_id: 'eventbus',
            raw_event: _.isString ? event : JSON.stringify(event)
        };

        if (error instanceof EventInvalidError) {
            this.event.message = error.errorsText;
        } else if (_.isError(error)) {
            this.event.message = error.message;
            this.event.stack = error.stack;
        } else {
            this.event.message = error;
        }
    }
}


// TODO full event error creation, using event-errors error schema.
// Would be good to make this a pluggable function to decouple from our error schema.

// function createEventError(error, event, req) {
//     const eventError = {
//         meta: {
//             schema_uri: 'error/2',
//         },
//         emitter_id: 'eventbus',
//         raw_event: _.isString ? event : JSON.stringify(event)
//     }

//     if (error instanceof EventInvalidError) {
//         eventError.message = error.errorsText;
//     }
//     else if (_.isError(error)) {
//         eventError.message = error.message;
//         eventError.stack = error.stack;
//     }
//     else {
//         eventError.message = error;
//     }

//     return eventError;
// }


module.exports = function(appObj) {

    app = appObj;

    // Create a new function that will be used by EventValidator to extract
    // schema URIs given an event to validate using the app configuration.
    const schemaUrlExtractor = eUtil.getSchemaUrl.bind(
        null,
        app.conf.schema_field,
        app.conf.schema_base_uri,
        app.conf.schema_file_extension
    );

    // TODO event (id) stringifier function for logging and errors?

    // This validator will be used to extract schema URLs from events with
    // the schemaUrlExtractor function, and then to validate those events
    // with the schemas found at those URLs.
    const validator = new EventValidator(schemaUrlExtractor);


    // If in mock/testing mode, use a mock Kafka Producer.
    const createKafkaProducer = app.conf.mock_kafka ? kafka.createMockKafkaProducer : kafka.createKafkaProducer;

    // Create a Kafka Producer using the app configuration.  Once the
    // Kafka Producer is ready, create the /events route.
    createKafkaProducer(
        app.conf.kafka.conf,
        app.conf.kafka.topic_conf
    ).then((kafkaProducer) => {

        router.post('/events', (req, res) => {
            // console.log('body is ', req.body);
            // If empty body, return 400 now.
            if (_.isEmpty(req.body)) {
                res.statusMessage = 'Must provide JSON encoded events in request body.';
                req.logger.log('warn/events', res.statusMessage);
                res.status(400);
                res.end();
                return;
            }

            let events = req.body;
            // TODO: Something is not right with spec.yaml x-amples tests.
            // Arrays are being encoded as integer-string keyed objects.
            // Temp hack to work around this til I figure it out.
            if (_.has(events, '0')) {
                events = _.values(events);
                // console.log('HAS 0, using values', events);
            }
            // Make sure events is an array, even if we were given only one event.
            events = _.isArray(events) ? events : [events];

            // console.log("events are ", events);
            // TODO: bikeshed this query param name.
            // If the requester wants a hasty response, return now!
            if (req.query.hasty) {
                res.statusMessage = `${events.length} events hastily received.`;
                req.logger.log('debug/events', res.statusMessage);
                res.status(204);
                res.end();
            }

            return P.map(events, (event) => {
                // validate() will validate event against the schema found at the
                // schema URL returned by schemaUrlExtractor, and then return the event.
                // The event may be modified; e.g. if the schema has a default for a field
                // but the event doesn't have it set. If the event failed validation,
                // an EventInvalidError will be thrown.
                return validator.validate(event)
                // If we are in this block, the event is valid, produce it.
                .then((event) => {
                    req.logger.log('trace/events', {
                        event,
                        message: 'Passed schema validation'
                    });

                    return produceEvent(event, app.conf.stream_field, kafkaProducer);
                })

                // TODO: Should we convert errors into HTTP errors?  I don't think so,
                // But probably some conversion could be done, especially to make it
                // easy to produce errored events to an error topic.

                // .catch(EventInvalidError, (err) => {
                //     // TODO: produce invalid event?
                //     return new HTTPError({
                //         status: 400,
                //         type: 'invalid',
                //         title: 'Event Validation Error',
                //         detail: `${err.message}. Errors: ${err.errorsText}`,
                //         errors: err.errors
                //     });
                // })
                .catch((err) => {
                    // console.log('FAILED! ', err, event);
                    // console.log(' FIRST BUT IS ', eUtil.objectProperty(err.errors[0]['dataPath'], event));
                    // TODO: ???
                    // return createEventError(err, event, req);
                    return new EventError(err, event, req);
                    // return err;
                });
            })
            // statuses will be a list of either node-rdkafka produce reports or Errors.
            .then((statuses) => {
                // Group event validation and production by status.
                // Some could succeed and some fail.
                const grouped = _.groupBy(statuses, (status) => {
                    return _.isError(status) ? 'failed' : 'success';
                });
                const eventFailures    = _.get(grouped, 'failed',   []);
                const eventSuccesses = _.get(grouped, 'success', []);

                // console.log('failures: ', eventFailures);
                // console.log('successes: ', eventSuccesses);

                // No errors, all events produced successfully.
                if (eventFailures.length === 0) {
                    const statusMessage = `All ${events.length} events were accepted.`;
                    req.logger.log('debug/events', statusMessage);

                    // Only set response if it hasn't yet finished,
                    // i.e. hasty response was not requested.
                    if (!res.finished) {
                        res.statusMessage = statusMessage;
                        res.status(204);
                        res.end();
                    }
                } else if (eventFailures.length !== events.length) {
                    const statusMessage = `${eventSuccesses.length} out of ${events.length} events were accepted, but ${eventFailures.length} failed.`;

                    // const eventErrors = eventFailures.map(err => createEventError(err, event))
                    req.logger.log('warn/events', { errors: eventFailures, message: statusMessage });

                    if (!res.finished) {
                        res.statusMessage = statusMessage;
                        res.status(207);
                        res.json({ errors: eventFailures });
                    }
                } else {
                    const statusMessage = `${eventSuccesses.length} out of ${events.length} events were accepted.`;
                    req.logger.log('warn/events', { errors: eventFailures, message: statusMessage });

                    if (!res.finished) {
                        res.statusMessage = statusMessage;
                        res.status(400);
                        res.json({ errors: eventFailures });
                    }
                }
            });
        });
    });


    // the returned object mounts the routes on
    // /{domain}/vX/mount/path
    return {
        path: '/v1',
        api_version: 1,  // must be a number!
        router,
        skip_domain: true
    };

};

