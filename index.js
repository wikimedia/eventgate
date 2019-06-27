'use strict';


const app = require('./app');

const {
    EventGate,
    EventStatus,
} = require('./lib/eventgate');

Object.assign(app, {
    EventGate,
    EventStatus,
    EventValidator: require('./lib/EventValidator'),
    error: require('./lib/error'),
    util: require('./lib/event-util'),
    kafka: require('./lib/kafka'),
});

module.exports = app;
