[![Build Status](https://travis-ci.org/wikimedia/eventgate.svg?branch=master)](https://travis-ci.org/wikimedia/eventgate)
[![Coverage Status](https://coveralls.io/repos/github/wikimedia/eventgate/badge.svg?branch=master)](https://coveralls.io/github/wikimedia/eventgate?branch=master)

# EventGate

EventGate takes in JSON events via HTTP POST, validates and then produces them
to a pluggable destination (usually to Kafka). Valid events pass through the
gate, invalid ones do not.

Throughout this codebase, an 'event' is a parsed JSON object with
a strict JSONSchema, and a 'schema' refers to an instance of a JSONSchema for
an event.

# Usage

For configuration of the default EventGate implementation (see below), edit
config.yaml and run `npm start`.  The service will listen for HTTP POST
requests with Content-Type set to `application/json` at `/v1/events`.  The POST
body should be an array of JSON event objects.  (The default EventGate uses
Kafka, so you must have a running Kafka instance to produce to.)


# Architecture

The EventGate service is a generic HTTP POST JSON event intake, event schema validation
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
This module is expected to export a function named `factory` that takes a conf `options` object,
a bunyan `logger`, and an optional `metrics` object that conforms to the node-statsd interface
(This will actually be provided from
[service-runner app metrics](https://github.com/wikimedia/service-runner#metric-reporting), and
the Express router used to handle the events (in case your EventGate implementation wants to
add any extra routes at this time).  E.g.

```javascript
function myEventGateFactory(options, logger, metrics, router) { ... }
````
The factory function should return a Promise of an instantiated EventGate.

Once the EventGate Promise resolves, the `/v1/events` HTTP route will be added and will use the
instantiated EventGate to validate and produce incoming events.


## EventGate class

The `EventGate` class in lib/eventgate.js handles event validation and produce logic.
It is instantiated with `validate` and a `produce` functions that each take a single
`event` and extra `context` object.  `validate` should either return a Promise of the validated
event (possibly augmented, e.g. field defaults populated) or throw a `ValidationError`.
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
functions should be able to do their job with only these arguments.
Any additional logic or context should be bound into the function, either by partially applying
or creating a closure.  Example:

If you wanted to write all incoming events to a file based on some field in the event, you
could write an EventGate `produce` function like this:

```javascript
const _ require('lodash');
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
`eventGate.process([errorEvents])` should work.  If your `mapToErrorEvent` implementation
returns `null` for any given failed `event`, no error event for that error will be
produced.  This allows `mapToErrorEvent` implementations to decide what types of
Errors should be produced.

# Default EventGate - Schema URI validation & producing with Kafka

If `eventgate_factory_module` is not specified, this service will use provided configuration
to instantiate and use an EventGate that validates events with JSONSchemas discovered via
schema URLs.  Depending on configuration, the default EventGate can write events to
a file, and/or produce them to Kafka.

## EventValidator class & event schema URLs

While the `EventGate` class that handles event validation and production can
be configured to do validation in any way, the default EventGate uses the
`EventValidator` class to validate events with schemas obtained from
schema URIs in the events themselves. Every event should contain a URI
to the JSONSchema for the event.  `EventValidator` will extract and use those URIs to look up
(and cache) those schemas to use for event validation.  The `EventValidator` instance
used by the default EventGate can request schema URIs from the local filesystem with
`file://` or remote ones via `http://` based URIs.  The field in the each event where the schema
URI is located is configured by the `schema_uri_field` config, which defaults to `$schema`.
(`$schema` is a standard field used by JSONSchemas to locate their metaschemas, so it makes
sense to store an event's schema in this field as well.)
When an event is received, the schema URI will be extracted from the `schema_uri_field`.
The JSONSchema at the URI will be downloaded and used to validate the event.
The extracted schema URI can optionally be prefixed with `schema_base_uri` and suffixed with
`schema_file_extension`.  Setting a `schema_base_uri` will allow set hostname relative URIs,
e.g. '/path/to/event-schema/1.0.0' in the events, while configuring the base location of your schema
repositories, e.g. 'http://my.schema-repo.org/schemas' If you
use the defaults, all of your events should have a $schema field set to
a resolvable schema URI.

EventValidator always supports draft-07 JSONSchemas (via AJV).  It also
supports additional JSONSchemas, defaulting to also supporting draft-04.
If you need to modify or change this, you can override the `metaSchemas` array
option to the EventValidator constructor.

By default, EventValidator will validate all (non-meta) schemas with AJV's
json-schema-secure schema.  This prevents schemas from including potentially
risky features that could facilitate DOS attacks.
See: https://github.com/epoberezkin/ajv#security-considerations
To allow insecure schemas, you can set `allowInsecureSchemas: true` in
the EventValidator constructor options.

## Streams
A 'stream' here refers to the destination name of an event.  It is closely related
to Kafka's concept of a topic.  Much of the time a stream might correspond 1:1 with
a Kafka topic.  If you don't care about the topic name that is used for a any given event,
you don't need to configure a `stream_field`.  The default behavior is to sanitize an event's
schema URI and use it for the Kafka topic name.  E.g. if an event's schema URI is
`/ui/element/button-push`, the topic name will end up being `ui_element_button-push`.
However, if `stream_field` is configured and present in an event, its value will be
used as the destination Kafka topic of that event. If you need finer control over
event -> Kafka topic mapping, you should implement your own Kafka produce function
(see
[eventgate-wikimedia](https://gerrit.wikimedia.org/r/plugins/gitiles/eventgate-wikimedia/+/refs/heads/master/eventgate-wikimedia.js))\
for an example.)

# Configuration

Configuration is passed to the service via the `config.yaml` file, which
has a `services` object.  This object contains a service named `eventgate`.
The `conf` object of this service will be passed to the `eventgate_factory_module`.
To use a custom EventGate implementation, set `eventgate_factory_module` to your
javascript module that exports a `factory` function that instantiate an EventGate with
`options`.  See the section above entitled 'EventGate implementation configuration'.

## Default EventGate configuration

The following values in `conf` will be used to instantiate a a default EventGate
that extracts JSONSchemas from schema URIs, validates events using those
schemas, and then produces them to an output file and or Kafka.
If `kafka.conf` is set, than Kafka will be used.  Since node-rdkafka-factory
is an optional dependency, please make sure it (and node-rdkafka) is properly
installed if you use this.

All `*_field` configs point to a field in an event, and use
dotted path notation to access sub-objects.
E.g. "value" will be extracted from `{ meta: { stream: "value" } }` if
`stream_field` is set to 'meta.stream'.

Property                    |         Default | Description
----------------------------|-----------------|--------------------------
`port`                      |            6927 | port on which the service will listen
`interface`                 |       localhost | hostname on which to listen
`user_agent`                |        eventgate | The UserAgent seen when making remote http requests (e.g. for remote schemas)
`schema_uri_field`          |         $schema | The value extracted from this field will be used (with `schema_base_uris` and `schema_file_extension`) to download the event's JSONSchema for validation.
`schema_base_uris`          |       undefined | If given, a relative schema URI will be prepended with each of these base URIs to build schema URLs.  The resulting URLs will each be requested, and the first existent schema found at that URL will be used. This allows you to configure multiple schema repositories/registries where your schema might be located.  E.g. you could use this if you wanted to have some schemas locally for reliability, but remote for resolvability.
`schema_file_extension`     |       undefined | If given, this will be appended to every extracted schema URI unless the filename in the URI already has an extension.
`stream_field`              |       undefined | The name of the stream this event belongs to. If not set, `schema_uri_field` will be used (and sanitized) instead.
`output_path`               |          stdout | Path to file to write valid events to, or 'stdout'. If undefined, events will not be output to a file.
`kafka.conf`                |       undefined | [node-rdkafka](https://blizzard.github.io/node-rdkafka/current/) / [librdkafka](https://github.com/edenhill/librdkafka/blob/master/CONFIGURATION.md) configuration.  This will be passed directly to the node-rdkafka `kafka.Producer` constructor.  Make sure you set kafka.conf['metadata.broker.list'].  If undefined, events will not be produced to Kafka.
`kafka.topic_conf`          |       undefined | node-rdkafka (and librdkafka) topic specific configuration.  This will be passed directly to the node-rdkafka `kafka.Producer` constructor.

# eventgate-wikimedia implementation and use as a dependency
The Wikimedia Foundation runs this EventGate service as a dependency of [eventgate-wikimedia](https://gerrit.wikimedia.org/g/eventgate-wikimedia/+/refs/heads/master).  WMF implements a custom
EventGate factory in [eventgate-wikimedia.js](https://gerrit.wikimedia.org/r/plugins/gitiles/eventgate-wikimedia/+/refs/heads/master/eventgate-wikimedia.js).

If you are using EventGate as an npm dependency in a custom implementation repository, you will
need to configure service-runner in your config.yaml file to run the EventGate express app.  Set:

```yaml
services:
  - name: EventGate-mycustom-implementation
    # Load the eventgate module which is installed as an npm dependency
    module: eventgate
    # Make service-runner start running via tha exported app function.
    entrypoint: app
    # ...
```

# /v1/_test/events route
If you are using EventGate as a service, and if `test_events` is configured,
a `GET /v1/_test/events` route will be added. When requested, the `test_events` will be produced as if
they were POSTed to /v1/events. This is useful for readiness probes that want to make sure the service can
produce events end to end.

# service-template-node

This service is based on Wikimedia's [service-template-node](https://github.com/wikimedia/service-template-node).  It is a fork of that 'template'
repository.  See also the [ServiceTemplateNode documentation](https://www.mediawiki.org/wiki/ServiceTemplateNode).
