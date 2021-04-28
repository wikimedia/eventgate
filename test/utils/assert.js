'use strict';

const { use } = require('chai');

module.exports = use(function (_chai, _utils) {
	const { assert } = _chai;

    assert.status = (res, expected) => {
        const msg = `Expected status to be ${expected}, but was ${res.status}`;
        new _chai.Assertion(res.status, msg, assert.status, true).to.eql(expected);
    };

    assert.contentType = (res, expectedRegexString) => {
        const actual = res.headers['content-type'];
        const msg = `Expected content-type to match ${expectedRegexString}, but was ${actual}`;
        new _chai.Assertion(actual, msg, assert.contentType, true).to.match(RegExp(expectedRegexString));
    };

    assert.fails = (promise, onRejected) => {

        let failed = false;

        function trackFailure(e) {
            failed = true;
            return onRejected(e);
        }

        function check() {
            if (!failed) {
                throw new Error('expected error was not thrown');
            }
        }
        return promise.catch(trackFailure).then(check);

    };

}).assert;
