# TODO

- Tests for schemas, validators and routes
- topic -> schema mapping config reading?  from local config files and remote service too?
- topic prefixing/transformation config (datacenter prefixing)
- invalid error produce topic
- Fire and forget valiation/kafka produce AKA return 204 immediately.

# Questions:
- How to deal with message keys?
- How to deal with partitioners?

- we should leave off file extensions from versioned schemas in the schema repo, so they work
  without appending them to the schema uris

- should we configure schemas for topics by final topic or by un prefixed stream name?


# event schema uri functional???

event -> schema_uri field
event -> FULL schema_url
event -> topic


valid -> function (kafka produce) -> http response?
invalid -> function (kafka produce) -> http response?



ValidatorCache: FULL schema_url -> validator / schema?

EventValidator(event -> full schema_url)

function schemaUrl(event) {
    topic = extractTopic(event)
}

