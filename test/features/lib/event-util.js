'use strict';

const assert = require('assert');
const eUtil  = require('../../../lib/event-util');

const testObject = { a: 'A', b: 1,  a0: { a1: { v: 123 } } };

describe('objectGet', () => {
    it('should lookup value by dotted path', () => {
        assert.equal(testObject.a0.a1.v, eUtil.objectGet(testObject, 'a0.a1.v'));
    });

    it('should throw PropertyNotFoundError', () => {
        assert.throws(() => {
            eUtil.objectGet(testObject, 'not.a.path');
        });
    });
});

describe('objectFindAndGet', () => {

    it('should lookup value by string dotted path', () => {
        assert.equal(testObject.a0.a1.v, eUtil.objectFindAndGet(testObject, 'a0.a1.v'));
    });

    it('should lookup value by first found dotted path', () => {
        assert.equal(testObject.b, eUtil.objectFindAndGet(testObject, ['nope', 'b']));
    });

    it('should throw PropertyNotFoundError', () => {
        assert.throws(() => {
            eUtil.objectGet(testObject, ['nope', 'not.a.path']);
        });
    });
});

describe('stringMatches', () => {
    it('should return true if string matches string', () => {
        assert.equal(true, eUtil.stringMatches('a', 'a'));
    });

    it('should return true if string matches string regex', () => {
        assert.equal(true, eUtil.stringMatches('a', '/^a$/'));
    });

    it('should return true if string matches RegExp', () => {
        assert.equal(true, eUtil.stringMatches('a', new RegExp('^a$')));
    });
});
