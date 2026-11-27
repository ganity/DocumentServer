const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createReadStream, statSync} = require('node:fs');
const {Readable} = require('node:stream');
const {test} = require('node:test');
const {createDeckWiseArchive} = require('./server/DocService/sources/deckwiseArchive');

const base = 'https://platform.example/courseware/document-server/';
const key = '0fa535f2-3355-4632-8575-96b934fe75f7';
const secret = 'integration-test-docs-access-secret';
const bytes = Buffer.from('PPTX save fixture');
const savedPptx = process.env.DECKWISE_TEST_SAVED_PPTX;
const size = savedPptx ? statSync(savedPptx).size : bytes.length;
const source = () => ({contentLength: size, readStream: savedPptx ? createReadStream(savedPptx) : Readable.from([bytes])});

test('PPTX is streamed to OSS before a saved-file receipt is returned, and a retry reuses it', async () => {
  let hasObject = false;
  let sent = 0;
  let expected;
  const request = async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url.href, base + 'archive-grant');
      assert.equal(options.headers['X-DeckWise-Docs-Access'], secret);
      expected = JSON.parse(options.body);
      assert.equal(expected.key, key);
      assert.equal(expected.size, size);
      return Response.json({url: hasObject ? null : 'https://fixtures.oss-cn-beijing.aliyuncs.com/saved.pptx?grant=1',
        headers: {'Content-MD5': expected.md5, 'x-oss-meta-source-sha256': expected.sha256,
          'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private'}});
    }
    assert.equal(url.hostname, 'fixtures.oss-cn-beijing.aliyuncs.com');
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers.get('content-length'), String(size));
    assert.equal(options.headers.get('x-deckwise-docs-access'), null);
    const hash = createHash('sha256');
    for await (const chunk of options.body) {
      sent += chunk.length;
      hash.update(chunk);
    }
    assert.equal(hash.digest('hex'), expected.sha256);
    hasObject = true;
    return new Response(null, {status: 200});
  };
  const archive = createDeckWiseArchive(base + 'editor-access', secret, request);
  assert.equal(await archive('https://other.example/callback', 6, key, source), null);
  const result = await archive(base + 'callback', 6, key, source);
  assert.deepEqual(result, {deckwiseArchiveSha256: expected.sha256, deckwiseArchiveSize: size});
  assert.deepEqual(await archive(base + 'callback', 2, key, source), result);
  assert.equal(sent, size);
});

test('a failed upload does not yield a saved-file receipt', async () => {
  const archive = createDeckWiseArchive(base + 'editor-access', secret, async (_url, options) => {
    if (options.method === 'PUT') return new Response(null, {status: 502});
    const intent = JSON.parse(options.body);
    return Response.json({url: 'https://fixtures.oss-cn-beijing.aliyuncs.com/saved.pptx?grant=1',
      headers: {'Content-MD5': intent.md5, 'x-oss-meta-source-sha256': intent.sha256, 'x-oss-forbid-overwrite': 'true'}});
  });
  await assert.rejects(archive(base + 'callback', 6, key, () => ({contentLength: bytes.length, readStream: Readable.from([bytes])})),
    /archive upload failed/);
});
