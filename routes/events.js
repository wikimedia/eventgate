'use strict';


var P = require('bluebird');
var preq = require('preq');
var sUtil = require('../lib/util');
// shortcut
var HTTPError = sUtil.HTTPError;


const _        = require('lodash');

const eUtil = require('../lib/eventbus-utils');
const {
    EventInvalidError,
    EventValidator
} = require('../lib/validator');

const kafka_factory = require('../lib/kafka');


// TODO: all this stuff from app config
var schemaField = 'meta.schema_uri';
var baseUri = 'file:///vagrant/srv/event-schemas/jsonschema/';
// var base_uri = 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema';
var fileExt = '.yaml';

const eventSchemaUrlFn = eUtil.getSchemaUrl.bind(null, schemaField, baseUri, fileExt);

const validator = new EventValidator(eventSchemaUrlFn);

var topicField = 'meta.topic';


/**
 * The main router object
 */
var router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
var app;



function produce_event(event, kafka_producer) {
    // TODO: support configurable keys / partitioners?
    return kafka_producer.produce(
        eUtil.getTopic(topicField, null, event), undefined, new Buffer(JSON.stringify(event)), undefined
    );
}



// TODO apply Kafka configs from app.config
kafka_factory.create_kafka_producer().then(kafka_producer => {
    return router.post('/events', (req, res) => {

        // validate will validate req.body as an event against the schema found at the
        // configured schema_uri_path, and then return the event.  The event may be
        // modified; e.g. if the schema has a default for a field but the event
        // doesn't have it set.
        let events;
        if (_.isArray(req.body))
            events = req.body;
        else
            events = [req.body];

        // TODO: if empty body fail now.



        return P.map(events, (event) => {
            return validator.validate(event)
            // If we are in this block, the event is valid, produce it.
            .then((event) => {
                req.logger.log('trace/events', {
                    event: event,
                    message: 'Passed schema validation'
                });

                return produce_event(event, kafka_producer);
            })
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
                // TODO: produce errored event?
                return err;
            })
        })
        .then((statuses) => {
            // Group event validation and production by status.
            // Some could succeed and some fail.
            const grouped = _.groupBy(statuses, (status) => {
                if (_.isError(status))
                    return 'error';
                else
                    return 'success';
            });
            let event_errors    = _.get(grouped, 'error',   [])
            let event_successes = _.get(grouped, 'success', []);

            // No errors, all events produced successfully.
            if (event_errors.length == 0) {
                res.statusMessage = `All ${events.length} events were accepted.`;
                res.status(204);
                res.end();
            }
            else if (event_errors.length != events.length) {
                res.statusMessage = `${event_successes.length} out of ${events.length} events were accepted, but ${event_errors.length} failed.`
                res.status(207);
                res.json({errors: event_errors});
            }
            else {
                res.statusMessage = `${event_successes.length} out of ${events.length} events were accepted.`;
                res.status(400);
                res.json({errors: event_errors});
            }
        });
    });
});

module.exports = function(appObj) {

    app = appObj;

    // the returned object mounts the routes on
    // /{domain}/vX/mount/path
    return {
        path: '/v1',
        api_version: 1,  // must be a number!
        router: router,
        skip_domain: true
    };

};

