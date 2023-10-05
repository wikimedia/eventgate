'use strict';

const sUtil = require('../lib/util');
const _     = require('lodash');

/**
 * The main router object
 */
const router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
let app;

/**
 * Given module path m, this will attempt to require it
 * with the extra paths at the end of module.paths.
 * module.paths will be unmodified when this function returns.
 *
 * @param {string} m
 * @param {Array<string>} paths list of extra paths to search for module.
 * @return {any}
 */
function requireRelative(m, paths = [process.cwd()]) {
    const originalModulePaths = module.paths;
    paths.forEach((path) => module.paths.push(path));
    try {
        return require(m);
    } finally {
        module.paths = originalModulePaths;
    }
}

/**
 * Handles incoming JSON events in req.body with the EventGate instance.
 *
 * @param {EventGate} eventGate
 * @param {Object} conf config object to provide in eventGate.process context.
 * @param {http.ClientRequest} req
 * @param {http.ServerResponse} res
 */
async function handleEvents(eventGate, conf, req, res) {

    // If empty body, return 400 now.
    if (_.isEmpty(req.body)) {
        res.statusMessage = 'Request body was empty. Must provide JSON encoded events.';
        req.logger.log('warn/events', res.statusMessage);
        res.status(400);
        res.end();
        return;
    }

    // Make sure events is an array, even if we were given only one event.
    // For possible usage of future
    const events = _.isArray(req.body) ? req.body : [req.body];

    // Provide this conf and request context to eventGate.process
    const context = {
        req,
        res,
        conf
    };

    // If the requester wants a hasty response, return now!
    if (req.query.hasty) {
        res.statusMessage = `${events.length} events hastily received.`;
        res.status(202);
        res.end();
    }

    let results;
    try {
        // Process events (validate and produce)
        results = await eventGate.process(events, context);
    } catch (err) {
        // Error and end response now if we encounter anything unexpected.
        // This probably shouldn't happen, as eventGate.process should catch Errors
        // and reform them into error EventStatuses.
        const statusMessage =
            `Encountered an unexpected error while processing events: ${err.message}`;
        req.logger.log('error/events', { error: err, message: statusMessage });
        res.statusMessage = statusMessage;
        res.status(500);
        res.end();
        throw err;
    }

    // Respond with appropriate HTTP status based on status of processing all events.
    const successCount = results.success.length;
    const invalidCount = results.invalid.length;
    const errorCount   = results.error.length;
    const failureCount = results.invalid.length + results.error.length;

    if (failureCount === 0) {
        // No failures, all events produced successfully: 204
        const statusMessage =
            `All ${successCount} out of ${events.length} events were accepted.`;
        req.logger.log('debug/events', statusMessage);

        // Only set response if it hasn't yet finished,
        // i.e. hasty response was not requested.
        if (!res.finished) {
            res.statusMessage = statusMessage;
            res.status(201);
            res.end();
        }
    } else if (invalidCount === events.length) {
        // All events were invalid: 400
        const statusMessage = `${invalidCount} out of ${events.length} ` +
            'events were invalid and not accepted.';
        req.logger.log('warn/events', statusMessage);

        if (!res.finished) {
            res.statusMessage = statusMessage;
            res.status(400);
            res.json({ invalid: results.invalid });
        }
    } else if (failureCount !== events.length) {
        // Some successes, but also some failures (invalid or errored): 207
        const statusMessage = `${results.success.length} out of ${events.length} ` +
            `events were accepted, but ${failureCount} failed (${invalidCount} ` +
            `invalid and ${errorCount} errored).`;
        req.logger.log('warn/events', statusMessage);

        if (!res.finished) {
            res.statusMessage = statusMessage;
            res.status(207);
            res.json({ invalid: results.invalid, error: results.error });
        }
    } else {
        // All events had some failure with at least one error
        // (some might have been invalid): 500
        const statusMessage = `${failureCount} out of ${events.length} ` +
            `events had failures and were not accepted. (${invalidCount} ` +
            `invalid and ${errorCount} errored).`;
        req.logger.log('error/events', statusMessage);

        if (!res.finished) {
            res.statusMessage = statusMessage;
            res.status(500);
            res.json({ invalid: results.invalid, error: results.error });
        }
    }
}

module.exports = async (appObj) => {

    app = appObj;

    // Instantiate EventGate from app.conf.  If eventgate_factory_module, require it
    // to create a custom EventGate instance.  Otherwise, use the default-eventgate factory.
    const eventGateFactoryModule = _.get(
        app.conf, 'eventgate_factory_module', '../lib/factories/default-eventgate'
    );
    app.logger.log(
        'info/events',
        `Instantiating EventGate from ${eventGateFactoryModule}`
    );

    // Search in cwd and service-runner app_base_path (the path where EventGate's app.js is)
    // as well as normal module.paths for eventgate_factory_module.
    // This is so that EventGate can be used as a library dependency with custom modules.
    const pathsToSearch = [process.cwd(), app.conf.app_base_path];
    const eventGate = await requireRelative(eventGateFactoryModule, pathsToSearch).factory(
        app.conf, app.logger._logger, app.metrics, router
    );
    router.post('/events', (req, res) => {
        handleEvents(eventGate, app.conf, req, res);
    });

    // If test_events are configured, then set up an GET /v1/_test/events route
    // that will pass the test_events through eventGate in the same way as if the
    // test_events were directly POSTed to /v1/events.  This is useful for
    // readiness probes that want to make sure the service can produce events end to end.
    if (app.conf.test_events) {
        router.get('/_test/events', (req, res) => {
            req.body = _.cloneDeep(app.conf.test_events);
            handleEvents(eventGate, app.conf, req, res);
        });
    }

    // the returned object mounts the routes on
    // /{domain}/vX/mount/path
    return {
        path: '/v1',
        api_version: 1,  // must be a number!
        router,
        skip_domain: true
    };

};
