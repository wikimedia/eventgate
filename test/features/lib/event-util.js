'use strict';

const fs     = require('fs');
const yaml   = require('js-yaml');
const path   = require('path');
const assert = require('assert');
const eUtil  = require('../../../lib/event-util');


const fileName = '_mocha_test_file.yaml'
const filePath = `/tmp/${fileName}`;
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

    it('should throw error for bad data', () => {
        assert.throws(() => {
            eUtil.objectFactory(123);
        });
    });
});

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

describe('urlGetFirstObject', () => {
    before(writeTempFile);
    after(unlinkTempFile);

    it('should get first existant object from list of urls', (done) => {
        const fileUrls = ['/tmp/non_existant1.yaml', fileUrl];
        eUtil.urlGetFirstObject(fileUrls).then((content) => {
            assert.deepEqual(testObject, content);
            done();
        });
    });

    it('should reject if there are no existant objects at list of urls', (done) => {
        const fileUrls = ['/tmp/non_existant1.yaml', '/tmp/non_existant2.yaml'];
        assert.rejects(() => {
            return eUtil.urlGetFirstObject(fileUrls)
            .finally(() => done());
        });
    });
});

describe('uriGetFirstObject', () => {
    before(writeTempFile);
    after(unlinkTempFile);

    it('should get first existant object at fileName in list of base URIs', (done) => {
        const baseURIs = ['file:///non_existant1/', 'file:///tmp/'];
        eUtil.uriGetFirstObject(fileName, baseURIs).then((content) => {
            assert.deepEqual(testObject, content);
            done();
        });
    });

    it('should reject if there are no existant objects at fileName in list of base URIs', (done) => {
        const baseURIs = ['file:///non_existant1/', 'file:///non_existant2/'];
        assert.rejects(() => {
            return eUtil.uriGetFirstObject(fileName, baseURIs)
            .finally(() => done());
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

describe('fileExtension', () => {
    it('should return empty if no file extension', () => {
        assert.equal('', eUtil.fileExtension('path/to/file'));
    });
    it('should return empty if no filename', () => {
        assert.equal('', eUtil.fileExtension(undefined));
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
