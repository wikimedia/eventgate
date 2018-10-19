# Eventbus - HTTP JSONSchema event validation and production to Kafka

Eventbus takes in JSON events via HTTP POST, validates them according to
JSONSchemas discovered via URLs, and produces them to the configured backends,
usually Kafka.

Throughout this code, an 'event' is meant to refer to a parsed JSON object with
a strict JSONSchema, and a 'schema' refers to an instance of a JSONSchema for
an event.

# Usage

TODO

# Architecture

Eventbus attempts to be a generic HTTP POST event intake, event schema validation
and event 'produce' service.  The schema validation and event produce implementation
is left up to the user.  This service ships with a schema URL based
validation and Kafka produce implementation, but you can plug in your own
by implementing a module that returns an instantiated `Eventbus` and use it
via `eventbus_init_module` application config.

## Event Schema URLs

While the `Eventbus` class that handles event validation and production can
be configured to do validation in any way, this library was designed with the
idea that event schemas should be identifiable and addressable via
URL syntax.  If your each of your events contain a URI to the JSONSchema
for the event, this library can extract and use those URIs to look up
and cache those schemas to use for event validation.  URIs can be
simple paths on the local filesystem with `file://` or an `http://` based
URI.


## Eventbus

The `Eventbus` class in lib/eventbus.js handles event validation and produce logic.
It is instantiated with `validate` and a `produce` functions that each take a single
event.  `validate` should either return a Promise of the validated event
(possibly augmented, e.g. field defaults populated) or throw an `EventInvalidError`.
`produce` is expected to return a Promise of the `produce` result, or throw an
`Error`.

Once instantiated with these injected functions, an `Eventbus` instance can be used
by calling `process` function with an array of parsed events.  This function will
catch both validation and produce errors, and will return an object with errors
for each event grouped by the type of error.  E.g. if you passed in 3 events,
and 1 was valid, 1 was invalid, and another encountered an unknown error, `process`
will return an object like:

```$javascript
{
    'success': [{ ... }],
    'invalid': [{ ... }],
    'error': [{ ... }]
}
```
with each array containing an `EventStatus` instance representing the event's process result.

## HTTP Event intake configuration

The EventBus class is generic enough to be used with any type of JSON validation and event production via its
function injection.  However, the HTTP route that handles POSTing of events needs to have an instantiated
EventBus instance.  To make this configurable (without actually editing the route code), the route in
routes/events.js will look for `app.conf.eventbus_init_module` and require it.  This module is expected to
export a single function that takes a `conf` object and a bunyan `logger`.  The function will return
an object with a Promise of an instantiated Eventbus in the `eventbus` key, and an optional `createEventError`
function.

Once the `eventbus` Promise resolves, the `/v1/events` route will be added and will use the instantiated
Eventbus to validate and produce incoming events.


If `createEventError` is returned from the require of eventbus_init_module, it should be a function that
takes an `error` and an `event` and returns a new error event representing `error` that is suitable
for producing through the instantiated `Eventbus`.  If it is defined and any incoming events fail
for any reason, those errors will be converted to event errors via this function, and then produced.
There should be no difference between the kind of events that `createEventError` returns and the kind
of events that your instantiated `Eventbus` can handle.  I.e. eventbus.produce([errorEvents]) should work.


## HTTP API


TODO
