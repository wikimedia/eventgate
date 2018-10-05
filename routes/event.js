'use strict';


var P = require('bluebird');
var preq = require('preq');
var sUtil = require('../lib/util');

// shortcut
var HTTPError = sUtil.HTTPError;

const EventInvalidError = require('../lib/schemas').EventInvalidError;
const EventValidator = require('../lib/schemas').EventValidator;

const kafka_factory = require('../lib/kafka');

var base_uri = 'file:///vagrant/srv/event-schemas/jsonschema/';
// var base_uri = 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema';
const validator = new EventValidator(base_uri);



/**
 * The main router object
 */
var router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
var app;


// TODO apply Kafka configs from app.config
kafka_factory.create_kafka_producer().then(kafka_producer => {
    return router.post('/events', (req, res) => {

        // validate will validate req.body as an event against the schema found at the
        // configured schema_uri_path, and then return the event.  The event may be
        // modified; e.g. if the schema has a default for a field but the event
        // doesn't have it set.
        return validator.validate(req.body)
            .then((event) => {
                req.logger.log('trace/events', {
                    event: event,
                    message: 'Passed schema validation'
                });
                // console.log(event, event.meta.topic);

                // TODO: support configurable keys / partitioners?
                kafka_producer.produce(
                    event.meta.topic, undefined, new Buffer(JSON.stringify(event)), undefined
                )
                .then((report) => {
                    console.log('REPORT', report);

                    // TODO should we augment event.meta with kafka stuff?  Perhaps
                    // an optional query param?  It could be quite nice to get back
                    // the exact Kafka topic, partition and offset, to be able
                    // to use them for auditing purposes later.

                    // TODO: do we want to return the (augmented?) event?  Probably not.
                    res.json(event);
                    return res.status(204);
                });
            })
            .catch(EventInvalidError, (err) => {
                throw new HTTPError({
                    status: 400,
                    type: 'invalid',
                    title: 'Event Validation Error',
                    detail: err.message + ' Errors: ' + err.errorsText,
                    errors: err.errors
                });
            })
            .catch(err => {
                throw new HTTPError(err);
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

