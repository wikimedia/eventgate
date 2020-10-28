'use strict';

const app = require('./app');

const {
    EventGate,
    EventStatus,
} = require('./lib/eventgate');

module.exports = {
    // Export app so that service-runner can use this as its
    // module entrypoint.
    app,
    EventGate,
    EventStatus,
    EventValidator: require('./lib/EventValidator'),
    error: require('./lib/error'),
    util: require('./lib/event-util'),
};
