const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');

test('GET /health returns 200 with {"status":"ok"}', async () => {
  const server = await startServer(createApp());
  try {
    const res = await fetch(`${server.url}/health`);
    const body = ((await res.json()) as any);

    assert.equal(res.status, 200);
    assert.deepEqual(body, { status: 'ok' });
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
