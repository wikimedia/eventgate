'use strict';


var P = require('bluebird');
var preq = require('preq');
var sUtil = require('../lib/util');
// shortcut
var HTTPError = sUtil.HTTPError;

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
var router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
var app;


function produceEvent(event, kafkaProducer) {
    // TODO: support configurable keys / partitioners?
    return kafkaProducer.produce(
        eUtil.getTopic(topicField, null, event), undefined, new Buffer(JSON.stringify(event)), undefined
    );
}


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

    // Create a Kafka Producer using the app configuration.  Once the
    // Kafka Producer is ready, create the /events route.
    kafka.createKafkaProducer(
        app.conf.kafka.conf,
        app.conf.kafka.topic_conf
    ).then((kafkaProducer) => {

        router.post('/events', (req, res) => {

            // If empty body, return 400 now.
            if (_.isEmpty(req.body)) {
                res.statusMessage = 'Must provide JSON events in request body.';
                res.status(400);
                res.end();
                return;
            }

            // Make sure events is an array, even if we were given only one event.
            const events = _.isArray(req.body) ? req.body : [req.body];

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
                        event: event,
                        message: 'Passed schema validation'
                    });

                    return produceEvent(event, kafkaProducer);
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
                //         detail: err.message + ' Errors: ' + err.errorsText,
                //         errors: err.errors
                //     });
                // })
                .catch((err) => {
                    // TODO: produce errored event
                    return err;
                })
            })
            // statuses will be a list of either node-rdkafka produce reports or Errors.
            .then((statuses) => {
                // Group event validation and production by status.
                // Some could succeed and some fail.
                const grouped = _.groupBy(statuses, (status) => {
                    return _.isError(status) ? 'error' : 'success';
                });
                const eventErrors    = _.get(grouped, 'error',   [])
                const eventSuccesses = _.get(grouped, 'success', []);

                // No errors, all events produced successfully.
                if (eventErrors.length == 0) {
                    res.statusMessage = `All ${events.length} events were accepted.`;
                    res.status(204);
                    res.end();
                }
                else if (eventErrors.length != events.length) {
                    res.statusMessage = `${eventSuccesses.length} out of ${events.length} events were accepted, but ${eventErrors.length} failed.`
                    res.status(207);
                    res.json({errors: eventErrors});
                }
                else {
                    res.statusMessage = `${eventSuccesses.length} out of ${events.length} events were accepted.`;
                    res.status(400);
                    res.json({errors: eventErrors});
                }
            });
        });
    });


    // the returned object mounts the routes on
    // /{domain}/vX/mount/path
    return {
        path: '/v1',
        api_version: 1,  // must be a number!
        router: router,
        skip_domain: true
    };

};

