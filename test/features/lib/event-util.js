'use strict';

const fs     = require('fs');
const yaml   = require('js-yaml');
const path   = require('path');
const assert = require('assert');
const eUtil  = require('../../../lib/event-util');


const filePath = '/tmp/_mocha_test_file.yaml';
const fileUrl = `file://${filePath}`;

const testObject = { a: 'A', b: 1,  a0: { a1: { v: 123 } } };

const testObjectJson = JSON.stringify(testObject);
const testObjectYaml = yaml.safeDump(testObject);

function writeTempFile() {
    fs.writeFileSync(filePath, testObjectYaml);
}

function unlinkTempFile() {
    fs.unlinkSync(filePath);
}


describe('objectFactory', () => {
    it('should return the same object it was given', () => {
        assert.deepEqual(testObject, eUtil.objectFactory(testObject));
    });

    it('should load from a JSON Buffer', () => {
        const b = Buffer.from(testObjectJson);
        assert.deepEqual(testObject, eUtil.objectFactory(b));
    });

    it('should load from a JSON string', () => {
        assert.deepEqual(testObject, eUtil.objectFactory(testObjectJson));
    });

    it('should load from a YAML string', () => {
        assert.deepEqual(testObject, eUtil.objectFactory(testObjectYaml));
    });
});

describe('objectGet', () => {
    // const o = { a0: { a1: { v: 123 } } };

    it('should lookup value by dotted path', () => {
        assert.equal(testObject.a0.a1.v, eUtil.objectGet(testObject, 'a0.a1.v'));
    });

    it('should throw PropertyNotFoundError', () => {
        assert.throws(() => {
            eUtil.objectGet(testObject, 'not.a.path');
        });
    });
});

describe('urlGet', () => {

    before(writeTempFile);
    after(unlinkTempFile);

    it('should get contents of file url', (done) => {
        eUtil.urlGet(fileUrl).then((content) => {
            assert.equal(testObjectYaml, content);
            done();
        });
    });
    // TODO test urlGet from http url?  set up test http server?
});

describe('urlGetObject', () => {

    before(writeTempFile);
    after(unlinkTempFile);

    it('should get object from yaml file url', (done) => {
        eUtil.urlGetObject(fileUrl).then((content) => {
            assert.deepEqual(testObject, content);
            done();
        });
    });

    // TODO test urlGet and urlGetObject from http url?  set up test http server?
});

describe('fileExtension', () => {
    it('should return empty if no file extension', () => {
        assert.equal('', eUtil.fileExtension('path/to/file'));
    });

    it('should return empty if numeric end of file name', () => {
        assert.equal('', eUtil.fileExtension('path/to/file/0.0.3'));
    });

    it('should return file extension', () => {
        assert.equal('yaml', eUtil.fileExtension('path/to/file.yaml'));
    });
});

describe('uriHasProtocol', () => {
    it('should return false if no protocol scheme', () => {
        assert.equal(false, eUtil.uriHasProtocol('path/to/file.yaml'));
    });

    it('should return true if protocol scheme', () => {
        assert.equal(true, eUtil.uriHasProtocol('file:///path/to/file.yaml'));
    });
});

describe('resolveUri', () => {
    const testUri = 'path/to/file';
    const absoluteTestUri = path.resolve(testUri);
    const cwd = path.resolve('.') + '/';

    it('should return file:// uri if no baseUri and no defaultFileExtension', () => {
        const expected = `file://${absoluteTestUri}`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, undefined, undefined)
        );
    });

    it('should return file:// uri with defaultFileExtension if no baseUri', () => {
        const expected = `file://${absoluteTestUri}.yaml`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, undefined, '.yaml')
        );
    });

    it('should return file:// uri with protocol-less baseUri and no defaultFileExtension', () => {
        const expected = `file://${absoluteTestUri}`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, cwd, undefined)
        );
    });

    it('should return file:// uri with protocol baseUri and no defaultFileExtension', () => {
        const expected = `file://${absoluteTestUri}`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, `file://${cwd}`, undefined)
        );
    });

    it('should return file:// uri with protocol baseUri and defaultFileExtension', () => {
        const expected = `file://${absoluteTestUri}.yaml`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, `file://${cwd}`, '.yaml')
        );
    });

    it('should return http:// uri with http:// protocol baseUri and defaultFileExtension', () => {
        const expected = `http://domain.example.com/${testUri}.yaml`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, 'http://domain.example.com/', '.yaml')
        );
    });

    it('should return http:// uri with http:// protocol baseUri and no defaultFileExtension', () => {
        const expected = `http://domain.example.com/${testUri}`;
        assert.equal(
            expected,
            eUtil.resolveUri(testUri, 'http://domain.example.com/', undefined)
        );
    });
});


describe('extractUrl', () => {
    const event = {
        meta: {
            schema_uri: '/test/0.0.1'
        }
    };
    const cwd = path.resolve('.');

    it('should return extracted and resolved file:// url from event', () => {
        const expected = `file://${cwd}${event.meta.schema_uri}`;
        assert.equal(expected, eUtil.extractUrl('meta.schema_uri', cwd, undefined, event));
    });

    it('should return extracted and resolved http:// url from event', () => {
        const expected = `http://domain.example.com${event.meta.schema_uri}`;
        assert.equal(expected, eUtil.extractUrl('meta.schema_uri', 'http://domain.example.com', undefined, event));
    });
});