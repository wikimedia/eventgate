'use strict';

const preq   = require('preq');
const TestRunner = require('service-runner/test/TestServer');

class TestServiceTemplateNodeRunner extends TestRunner {

// --- BEGIN EventGate modification ---
    constructor(configPath = `${__dirname}/../config.test.yaml`) {
// --- END EventGate modification ---
		super(configPath);
		this._spec = null;
	}

	get config() {
		if (!this._running) {
			throw new Error('Accessing test service config before starting the service');
		}

		// build the API endpoint URI by supposing the actual service
		// is the last one in the 'services' list in the config file
		const myServiceIdx = this._runner._impl.config.services.length - 1;
		const myService = this._runner._impl.config.services[myServiceIdx];
		const uri = `http://localhost:${myService.conf.port}/`;
		if (!this._spec) {
			// We only want to load this once.
			preq.get(`${uri}?spec`)
				.then((res) => {
					if (!res.body) {
						throw new Error('Failed to get spec');
					}
					// save a copy
					this._spec = res.body;
				})
				.catch((err) => {
					// this error will be detected later, so ignore it
					this._spec = { paths: {}, 'x-default-params': {} };
				})
				.then(() => {
					return {
						uri,
						service: myService,
						conf: this._runner._impl.config,
						spec: this._spec
					};
				});
		}

		return {
			uri,
			service: myService,
			conf: this._runner._impl.config,
			spec: this._spec
		};

	}
}

module.exports = TestServiceTemplateNodeRunner;
