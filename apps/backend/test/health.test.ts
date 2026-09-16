const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');

test('GET /health returns 200, says it is ok, and says which build', async () => {
  const server = await startServer(createApp());
  try {
    const res = await fetch(`${server.url}/health`);
    const body = ((await res.json()) as any);

    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');

    // #41 added the build identity. `/health` answered a bare `ok` while the
    // deployed API could not issue a token to anyone and had no provider
    // credentials at all — both for days. It still does not report dependency
    // state (that is `/admin/diagnostics`, behind a token), but it now says
    // WHICH BUILD is answering, which is what makes a deploy verifiable from
    // outside instead of inferred by poking at routes.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['commit', 'startedAt', 'status', 'uptimeSeconds', 'version']
    );
    assert.ok(body.version);
    assert.ok(Number.isInteger(body.uptimeSeconds));

    // Public and unauthenticated, so it must give nothing else away.
    assert.doesNotMatch(
      JSON.stringify(body),
      /postgres|redis|secret|password|sk_(test|live)|whsec/i
    );
  } finally {
    await server.close();
  }
});

test('an unknown route returns the unified error shape', async () => {
  const server = await startServer(createApp());
  try {
    const res = await fetch(`${server.url}/no-such-route`);
    const body = ((await res.json()) as any);

    assert.equal(res.status, 404);
    // Exactly one key, named error, carrying a human-readable string.
    // docs/02-API-CONTRACT.md §2.
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  } finally {
    await server.close();
  }
});

test('malformed JSON is reported as a client error, not a 500', async () => {
  const server = await startServer(createApp());
  try {
    const res = await fetch(`${server.url}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });
    const body = ((await res.json()) as any);

    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(body), ['error']);
  } finally {
    await server.close();
  }
});
