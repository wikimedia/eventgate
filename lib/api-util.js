'use strict';

const Template = require('swagger-router').Template;

// --- BEGIN EventGate modification ---
// Remove unused functions
 // --- END EventGate modification ---

/**
 * Sets up the request templates for MW and RESTBase API requests
 *
 * @param {!Application} app the application object
 */
function setupApiTemplates(app) {

	// set up the MW API request template
	if (!app.conf.mwapi_req) {
		app.conf.mwapi_req = {
			method: 'post',
			uri: 'http://{{domain}}/w/api.php',
			headers: '{{request.headers}}',
			body: '{{ default(request.query, {}) }}'
		};
	}
	app.mwapi_tpl = new Template(app.conf.mwapi_req);

	// set up the RESTBase request template
	if (!app.conf.restbase_req) {
		app.conf.restbase_req = {
			method: '{{request.method}}',
			uri: 'http://{{domain}}/api/rest_v1/{+path}',
			query: '{{ default(request.query, {}) }}',
			headers: '{{request.headers}}',
			body: '{{request.body}}'
		};
	}
	app.restbase_tpl = new Template(app.conf.restbase_req);

}

module.exports = {
// --- BEGIN EventGate modification ---
// Remove unused functions
 // --- END EventGate modification ---
	setupApiTemplates
};
