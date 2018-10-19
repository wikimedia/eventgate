# EventBus - HTTP JSONSchema event validation and production to Kafka

EventBus takes in JSON events via HTTP POST, validates them according to
JSONSchemas discovered via URLs, and produces them to the configured backends,
usually Kafka.

Throughout this code, an 'event' is meant to refer to a parsed JSON object with
a strict JSONSchema, and a 'schema' refers to an instance of a JSONSchema for
an event.

# Usage

TODO

# Architecture

## Event Schema URLs

While the `EventBus` class that handles event validation and production can
be configured to do validation in any way, this library was designed with the
idea that event schemas should be identifiable and addressable via
URL syntax.  If your each of your events contain a URI to the JSONSchema
for the event, this library can extract and use those URIs to look up
and cache those schemas to use for event validation.  URIs can be
simple paths on the local filesystem with `file://` or an `http://` based
URI.


## EventBus

The `EventBus` class in lib/eventbus.js handles event validation and produce logic.
It is instantiated with `validate` and a `produce` functions that each take a single
event.  `validate` should either return a Promise of the validated event
(possibly augmented, e.g. field defaults populated) or throw an `EventInvalidError`.
`produce` is expected to return a Promise of the `produce` result, or throw an
`Error`.

Once instantiated with these injected functions, an `EventBus` instance can be used
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

## HTTP API


TODO
