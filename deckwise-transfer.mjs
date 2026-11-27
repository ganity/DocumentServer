import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const secret = Buffer.from(process.env.DECKWISE_DOCS_ACCESS_SECRET ?? '');
const ossOrigin = process.env.DECKWISE_TRANSFER_OSS_ORIGIN;
const docsOrigin = process.env.DECKWISE_TRANSFER_DOCS_ORIGIN;
const maxBytes = 1024 ** 3;
if (secret.length < 32 || !ossOrigin || !docsOrigin) throw new Error('Invalid DeckWise transfer configuration');
let active = 0;

function checked(value, expectedOrigin) {
  const url = new URL(value);
  if (url.origin !== expectedOrigin || url.username || url.password || url.hash) throw new Error('Invalid transfer origin');
  return url;
}

async function* measure(body, state, limit) {
  for await (const chunk of body) {
    state.size += chunk.length;
    if (state.size > limit) throw new Error('Transfer exceeds size limit');
    state.hash.update(chunk);
    yield chunk;
  }
  if (!state.size) throw new Error('Empty transfer');
}

const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers['x-deckwise-docs-access'] ?? '');
  if (supplied.length !== secret.length || !timingSafeEqual(secret, supplied)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== 'POST' || !['/archive', '/verify'].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  if (active >= 2) {
    response.writeHead(503).end();
    return;
  }
  active++;
  const signal = AbortSignal.timeout(240_000);
  let directory;
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString('utf8');
      if (body.length > 20_000) throw new Error('Transfer request too large');
    }
    const data = JSON.parse(body);
    const archive = request.url === '/archive';
    const limit = archive ? maxBytes : data.byteLength;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxBytes) throw new Error('Invalid transfer size');
    const source = checked(data.sourceUrl, archive ? docsOrigin : ossOrigin);
    const target = archive ? checked(data.uploadUrl, ossOrigin) : undefined;
    const upstream = await fetch(source, { signal, redirect: 'error', headers: { 'Accept-Encoding': 'identity' } });
    if (upstream.status !== 200 || !upstream.body || Number(upstream.headers.get('content-length')) > limit) {
      await upstream.body?.cancel();
      throw new Error('Transfer source unavailable');
    }
    if (upstream.headers.has('content-encoding')) {
      await upstream.body.cancel();
      throw new Error('Invalid transfer encoding');
    }
    const state = { size: 0, hash: createHash('sha256') };
    const bytes = measure(upstream.body, state, limit);
    if (target) {
      directory = await mkdtemp(join(tmpdir(), 'deckwise-docs-save-'));
      const file = join(directory, 'archive.pptx');
      await pipeline(bytes, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
      const upload = await fetch(target, {
        method: 'PUT', body: createReadStream(file), duplex: 'half', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Length': String(state.size), 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
      });
      await upload.body?.cancel().catch(() => {});
      if (!upload.ok) throw new Error('Archive upload unavailable');
    } else {
      for await (const _ of bytes) { /* Hash the response without retaining it. */ }
      if (state.size !== limit) throw new Error('Wrong object size');
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ byteLength: state.size, sha256: state.hash.digest('hex') }));
  } catch {
    response.writeHead(502).end();
  } finally {
    active--;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

server.listen(Number(process.env.DECKWISE_TRANSFER_PORT ?? '3091'), '0.0.0.0');
