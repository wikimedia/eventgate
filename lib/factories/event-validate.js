'use strict';

const _        = require('lodash');
const EventValidator = require('../../lib/EventValidator');

const {
    objectGet,
    resolveUri,
} = require('../../lib/event-utils');

/**
 * Creates a new schema URI based EventValidator using app.conf settings.
 * conf.schema_uri_field, conf.schema_base_uri, and conf.schema_file_extension are all used.
 */
function createFromConf(conf, logger) {
    const schemaUriField = _.get(conf, 'schema_uri_field', '$schema');
    const eventValidator = new EventValidator(
        event => objectGet(event, schemaUriField),
        uri => resolveUri(uri, conf.schema_base_uri, conf.schema_file_extension),
        undefined,
        logger
    );

    return eventValidator.validate.bind(eventValidator);
}

module.exports = {
    factory: createFromConf
};
