# EventGate

EventGate takes in JSON events via HTTP POST, validates and then produces them
to a pluggable destination (usually to Kafka). Valid events pass through the
gate, invalid ones do not.

Throughout this code, an 'event' is meant to refer to a parsed JSON object with
a strict JSONSchema, and a 'schema' refers to an instance of a JSONSchema for
an event.

# Usage

For configuration of the default EventGate implementation (see below), edit
config.yaml and run `npm start`.  The service will listen for HTTP POST
requests with Content-Type set to `application/json` at `/v1/events`.  The POST
body should be an array of JSON event objects.

# Architecture

The EventGate service attempts to be a generic HTTP POST event intake, event schema validation
and event producing service.  The schema validation and event produce implementation
is left up to the user.  This service ships with a schema URL based
validator and Kafka produce implementation (using node-rdkafka), but you can
plug in your own by implementing a factory module that returns an instantiated `EventGate`
and use it via `eventgate_factory_module` application config.  See documentation below for more on
the default Kafka EventGate.

## EventGate implementation configuration

The `EventGate` class is generic enough to be used with any type of validation and event
production via function injection.  The HTTP route that handles POSTing of events needs to have an
instantiated EventGate instance.  To make this configurable (without editing the route code), the
route in routes/events.js will look for `app.conf.eventgate_factory_module` and require it.
This module is expected to export a function named `factory` that takes a conf `options` object
and a bunyan `logger`. The function should return a Promise of an instantiated EventGate.

Once the EventGate Promise resolves, the `/v1/events` HTTP route will be added and will use the
instantiated EventGate to validate and produce incoming events.


## EventGate class

The `EventGate` class in lib/eventgate.js handles event validation and produce logic.
It is instantiated with `validate` and a `produce` functions that each take a single
`event` and extra `context` object.  `validate` should either return a Promise of the validated
event (possibly augmented, e.g. field defaults populated) or throw an `EventInvalidError`.
`produce` is expected to return a Promise of the `produce` result, or throw an
`Error`.

Once instantiated with these injected functions, an `EventGate` instance can be used
by calling the `process` function with an array of events and any extra `context`.
`process` will catch both validation and produce errors, and will return an object
with errors for each event grouped by the type of error.  E.g. if you passed in 3 events,
and 1 was valid, 1 was invalid, and another encountered an unknown error, `process`
will return an object like:

```$javascript
{
    'success': [{ ... }],
    'invalid': [{ ... }],
    'error':   [{ ... }]
}
```
with each array containing an `EventStatus` instance representing the event's process result.

Throughout the code, functions that are injected into to constructors are expected
to take a single `event` object and a `context` object.
E.g. `validate(event, context)`, `produce(event, context)`, etc.  These
functions are expected to be able to do their job with only these arguments.
Any additional logic or context should be bound into the function, either by partially applying
or creating a closure.  Example:

If you wanted to write all incoming events to a file based on some field in the event, you
could write an EventGate `produce` function like this:

```javascript
const writeFileAsync = promisify(fs.writeFile);
/**
 * @return a function that writes event to the file at event[file_path_field]
 */
function makeProduceFunction(options) {
    const file_path_field = options.file_path_field;
    return (event, context = {}) => {
        const path = _.get(event, file_path_field);
        return writeFileAsync(path, JSON.stringify(event));
    }
}

// Instantiate a new EventGate using this configured produce function closure:
const eventGate = new EventGate({
    // ...,
    const options = {
        file_path_field: 'file_path'
    }
    produce: makeProduceFunction(options);
    // ...,
})

// This eventGate will produce every event by calling the function returned by makeProduceFunction.
```

### Error events

The EventGate constructor also takes an optional `mapToErrorEvent` function.
`mapToErrorEvent` takes an `event` and an `error` and returns a new error event representing
the error.  This new error event should be suitable for producing through the same
instantiated `EventGate`.  If `mapToErrorEvent` is provided and event processing fails for any
reason, those errors will be converted to event errors via this function, and then produced.
There should be no difference between the kind of events that `mapToErrorEvent` returns and
the kind of events that your instantiated `EventGate` can handle.
`eventGate.produce([errorEvents])` should work.  If your `mapToErrorEvent` implementation
returns `null` for any given failed `event`, no error event for that error will be
produced.  This allows `mapToErrorEvent` implementations to decide what types of
Errors should be produced.

# Default EventGate - Schema URI validation & producing with Kafka

If `eventgate_factory_module` is not specified, this service will use provided configuration
to instantiate and use an EventGate that validates events with JSONSchemas discovered via
schema URLs, and produces valid events to Kafka.

## EventValidator class & event schema URLs

While the `EventGate` class that handles event validation and production can
be configured to do validation in any way, the default EventGate uses the
`EventValidator` class to validate events with schemas obtained from
schema URIs in the events themselves. Every event should contain a URI
to the JSONSchema for the event.  `EventValidator` will extract and use those URIs to look up
(and cache) those schemas to use for event validation.  The `EventValidator` instance
used by the default EventGate can request schema URIs from the local filesystem with
`file://` or remote ones via `http://` based URIs.  The field in the each event where the schema
URI is located is configured by the `schema_uri_field` config.  When an event is received, the
schema URI will be extracted from the `schema_uri_field`.  The JSONSchema at the
URI will be downloaded and used to validate the event.  The extracted schema URI
can optionally be prefixed with `schema_base_uri` and suffixed with
`schema_file_extension`.  The default `schema_uri_field` is $schema.  If you
use the defaults, all of your events should have a $schema field set to
a resolvable schema URI.

## Streams
A 'stream' here refers to the destination name of an event.  It is closely related
to Kafka's concept of a topic.  Much of the time a stream might correspond 1:1 with
a Kafka topic.  If you don't care about the topic name that is used for a any given event,
you don't need to configure this.  The default behavior is to sanitize an event's
schema URI and use it for the Kafka topic name.  E.g. if an event's schema URI is
`ui/element/button-push`, the topic name will end up being `ui_element_button-push`.
However, if `stream_field` is configured and present in an event, its value will be
used as the destination Kafka topic of that event. If you need finer control over
event -> Kafka topic mapping, you should implement your own Kafka produce function
(see, e.g. wikimedia-eventgate) that does so.

# Configuration

Configuration is passed to the service via the `config.yaml` file, which
has a `services` object.  This object contains a service named `eventgate`.
The `conf` object of this service will be passed to the `eventgate_factory_module`.
To use a custom EventGate implementation, set `eventgate_factory_module` to your
javascript module that exports a `factory` function that instantiate an EventGate with
`options`.  See the section above entitled 'EventGate implementation configuration'.

## Default Kafka EventGate configuration

The following values in `conf` will be used to instantiate a a default EventGate
that extracts JSONSchemas from schema URIs, validates events using those
schemas, and then produces them to Kafka.

All `*_field` configs point to a field in an event, and use
dotted path notation to access sub-objects.
E.g. "value" will be extracted from `{ meta: { stream_name: "value" } }` if
`stream_field` is set to 'meta.stream_name'.

Property                    |         Default | Description
----------------------------|-----------------|--------------------------
`port`                      |            6927 | port on which the service will listen
`interface`                 |       localhost | hostname on which to listen
`user_agent`                |        eventgate | The UserAgent seen when making remote http requests (e.g. for remote schemas)
`schema_uri_field`          |         $schema | The value extracted from this field will be used (with `schema_base_uri` and `schema_file_extension`) to download the event's JSONSchema for validation.
`schema_base_uri`           |       undefined | If given, this will be prefixed to every extracted schema URI.
`schema_file_extension`     |       undefined | If given, this will be appendede to every extracted schema URI unless the filename in the URI already has an extension.
`stream_field`              |       undefined | The name of the stream this event belongs to. If not set, `schema_uri_field` will be used (and sanitized) instead.
`kafka.conf`                |                 | [node-rdkafka](https://blizzard.github.io/node-rdkafka/current/) / [librdkafka](https://github.com/edenhill/librdkafka/blob/master/CONFIGURATION.md) configuration.  This will be passed directly to the node-rdkafka `kafka.Producer` constructor.  Make sure you set kafka.conf.metadata_broker_list.
`kafka.topic_conf`          |                 | node-rdkafka (and librdkafka) topic specific configuration.  This will be passed directly to the node-rdkafka `kafka.Producer` constructor.


# service-template-node

This service is based on Wikimedia's [service-tempate-node](https://github.com/wikimedia/service-template-node).  It is a fork of that 'template'
repository.  See also the [ServiceTemplateNode documentation](https://www.mediawiki.org/wiki/ServiceTemplateNode).


# TODO

- Tests for eventgate, default-eventgate, wikimedia-eventgate, etc.
- monitoring/metrics (for kafka, etc.)
- security review of AJV
- close() method for EventGate. ? graceful kafka shutdown?


## Questions/Thoughts:
- We should leave off file extensions from versioned schemas in the schema repo, so they work without appending them to the schema uris
