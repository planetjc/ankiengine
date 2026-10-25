// When OpenRouter cannot be reached at all (offline, DNS, a firewall, VPN or
// proxy, antivirus that intercepts secure connections), Node's fetch says
// only "fetch failed", and that is what a person saw when the app could not
// connect. These cases pin the message that replaced it: it names the host,
// what stopped the request, and the error code.
//
// The first three run through the built sidecar against real sockets, so the
// error shapes are Node's own. The rest feed `validateKey`/`listModels` the
// shapes Node produces for failures a test cannot stage locally (DNS, TLS,
// timeouts), as captured from Node 24's fetch.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import test, { after } from 'node:test';

import { listModels, validateKey } from '../../dist/agent/models.js';
import { connectGood, expectError, freshId, makeSessionDirs, runPrompt, spawnOpenRouterSidecar, assertKeyHygiene, text, GOOD_KEY } from './openrouter-helpers.ts';
import { startFakeOpenRouter, type FakeOpenRouter } from './fake-openrouter.ts';
import { TIMEOUT, sweepSidecars } from './helpers.ts';

after(() => { sweepSidecars(); assertKeyHygiene(); });

/** A local port nothing listens on: bound, then let go. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Spawns a sidecar aimed at `baseUrl` and runs agent/connect there with the good key. */
async function connectTo(baseUrl: string) {
  const dirs = makeSessionDirs();
  const s = spawnOpenRouterSidecar({ baseUrl } as FakeOpenRouter, dirs.cwd);
  await s.ready;
  const res = await s.request(freshId(), 'agent/connect', { provider: 'openrouter', dataDir: dirs.dataDir, cwd: dirs.cwd, apiKey: GOOD_KEY });
  return { s, res };
}

test('agent/connect with nothing listening says the connection was refused, naming host and code', { timeout: TIMEOUT }, async () => {
  const port = await closedPort();
  const { s, res } = await connectTo(`http://127.0.0.1:${port}/api/v1`);
  const err = expectError(res, -32000, 'refused');
  assert.equal(err.message, `Could not reach OpenRouter at 127.0.0.1:${port}: the connection was refused (ECONNREFUSED). A firewall, VPN or proxy may be blocking it.`);
  assert.equal(await s.end(), 0);
});

test('agent/connect to a server that drops the connection says it was cut off', { timeout: TIMEOUT }, async () => {
  const dropper: Server = createServer((sock) => sock.destroy());
  await new Promise<void>((r) => dropper.listen(0, '127.0.0.1', r));
  const { port } = dropper.address() as { port: number };
  try {
    const { s, res } = await connectTo(`http://127.0.0.1:${port}/api/v1`);
    const err = expectError(res, -32000, 'dropped');
    // Which of the two codes depends on whether the request was written before the close.
    assert.match(err.message, new RegExp(`^Could not reach OpenRouter at 127\\.0\\.0\\.1:${port}: the connection was cut off \\((ECONNRESET|UND_ERR_SOCKET)\\)\\. A firewall, VPN or proxy may be blocking it\\.$`));
    assert.equal(await s.end(), 0);
  } finally {
    await new Promise<void>((r) => dropper.close(() => r()));
  }
});

test('a prompt after OpenRouter goes away says the same, not "fetch failed"', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeOpenRouter();
  const port = new URL(fake.baseUrl).port;
  const { s, sessionId } = await connectGood(fake);
  await fake.close();
  const run = await runPrompt(s, sessionId, [text('hello')]);
  const err = expectError(run.response, -32000, 'prompt after close');
  assert.equal(err.message, `Could not reach OpenRouter at 127.0.0.1:${port}: the connection was refused (ECONNREFUSED). A firewall, VPN or proxy may be blocking it.`);
  assert.equal(await s.end(), 0);
});

// ---- shapes Node's fetch gives for failures a test cannot stage -----------

const BASE = 'https://openrouter.ai/api/v1';

/** What Node's fetch throws: TypeError("fetch failed") with the real error as `cause`. */
function fetchFailed(cause: unknown): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed', { cause });
  }) as unknown as typeof fetch;
}
function coded(message: string, code: string, name = 'Error'): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  e.name = name;
  return e;
}
const at = (reason: string) => `Could not reach OpenRouter at openrouter.ai: ${reason}`;

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.equal((e as Error).name, 'OpenRouterError');
    assert.ok(!(e as Error).message.includes('secret-key'), 'the key is never in the message');
    return (e as Error).message;
  }
  assert.fail('expected the request to fail');
}

test('DNS failures (ENOTFOUND, EAI_AGAIN) say the name could not be looked up', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    const msg = await messageOf(validateKey(BASE, 'secret-key', fetchFailed(coded(`getaddrinfo ${code} openrouter.ai`, code))));
    assert.equal(msg, at(`the name could not be looked up (${code}). Check the internet connection.`));
  }
});

test('untrusted or broken certificates say so and name the usual causes', async () => {
  // DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID and
  // SELF_SIGNED_CERT_IN_CHAIN are what Node 24 reported against badssl.com;
  // UNABLE_TO_GET_ISSUER_CERT_LOCALLY is the usual one behind HTTPS inspection.
  for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const msg = await messageOf(validateKey(BASE, 'secret-key', fetchFailed(coded('certificate problem', code))));
    assert.equal(msg, at(`its security certificate was not trusted (${code}). Antivirus, a VPN or a work network that inspects secure connections can cause this.`), code);
  }
});

test('a connect timeout says the connection timed out', async () => {
  const cause = coded('Connect Timeout Error (attempted address: openrouter.ai:443, timeout: 10000ms)', 'UND_ERR_CONNECT_TIMEOUT', 'ConnectTimeoutError');
  const msg = await messageOf(validateKey(BASE, 'secret-key', fetchFailed(cause)));
  assert.equal(msg, at('the connection timed out (UND_ERR_CONNECT_TIMEOUT). Check the internet connection, VPN or firewall.'));
});

test('an AggregateError with an empty message still yields its code, on itself or only on its errors', async () => {
  const refused = () => coded('connect ECONNREFUSED', 'ECONNREFUSED');
  const withCode = Object.assign(new AggregateError([refused(), refused()], ''), { code: 'ECONNREFUSED' });
  const innerOnly = new AggregateError([new Error('no code here'), coded('connect EHOSTUNREACH', 'EHOSTUNREACH')], '');
  assert.equal(await messageOf(validateKey(BASE, 'secret-key', fetchFailed(withCode))), at('the connection was refused (ECONNREFUSED). A firewall, VPN or proxy may be blocking it.'));
  assert.equal(await messageOf(validateKey(BASE, 'secret-key', fetchFailed(innerOnly))), at('there is no network route to it (EHOSTUNREACH). Check the internet connection.'));
});

test('no code at all falls back to the deepest message, not "fetch failed"', async () => {
  const msg = await messageOf(validateKey(BASE, 'secret-key', fetchFailed(new Error('bad port'))));
  assert.equal(msg, at('bad port.'));
  const unknown = await messageOf(validateKey(BASE, 'secret-key', fetchFailed(coded('something new', 'E_SOMETHING_NEW'))));
  assert.equal(unknown, at('something new (E_SOMETHING_NEW).'));
});

test('GET /models gets the same message when it cannot reach OpenRouter', async () => {
  const msg = await messageOf(listModels(BASE, 'secret-key', fetchFailed(coded('getaddrinfo ENOTFOUND openrouter.ai', 'ENOTFOUND'))));
  assert.equal(msg, at('the name could not be looked up (ENOTFOUND). Check the internet connection.'));
});
