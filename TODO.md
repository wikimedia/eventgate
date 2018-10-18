# TODO

- Tests for schemas, validators and routes
- topic -> schema mapping config reading?  from local config files and remote service too?
- monitoring/metrics

# Questions:
- How to deal with message keys?
- How to deal with partitioners?

- we should leave off file extensions from versioned schemas in the schema repo, so they work
  without appending them to the schema uris

- should we configure schemas for topics by final topic or by un prefixed stream name?

- should we have a query param to allow/disallow parital batch production on any error?
  i.e. should remaining events be produced if one fails?  This is the default behavior,
  but maybe users want to configure this.

- should lib/eventbus.js be a standalone lib?
