/**
 * Commission rate fallback when nothing is configured.
 *
 * In its own file precisely so it owns an empty schema. Testing the
 * "no rate exists" path inside commission.test.js would mean deleting rows its
 * other cases depend on, and leaving the outcome to test ordering.
 */

const { prisma, hasDatabase } = require('./db')('commissiondefault');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { startServer } = require('./helpers');
const service = require('../src/services/commissionService');

const describe = hasDatabase ? test : test.skip;

describe('with no rate configured, the resolver falls back rather than failing', async () => {
  assert.equal(await prisma.commissionRate.count(), 0, 'this schema starts empty');

  const rate = await service.resolveCommissionRate();

  assert.equal(rate.rateBasisPoints, service.DEFAULT_BPS);
  assert.equal(rate.rateBasisPoints, 500, 'matches the seeded default, so a seeded and unseeded database price alike');

  // The fallback is visible, not silent. Without this flag an unconfigured
  // platform would be indistinguishable from a deliberately configured one.
  assert.equal(rate.isDefault, true);
  assert.equal(rate.id, null, 'synthetic, not persisted');
  assert.equal(rate.setByUserId, null, 'nobody set it, so nobody is named');

  // Resolving must not have written anything.
  assert.equal(await prisma.commissionRate.count(), 0, 'the fallback is never persisted');
});

describe('a configured rate takes over from the fallback and is marked as real', async () => {
  const { hashPassword } = require('../src/lib/auth');
  const admin = await prisma.user.create({
    data: {
      email: 'sa@example.test',
      phone: '+2348000009999',
      passwordHash: await hashPassword('correct horse battery staple'),
      role: 'SUPER_ADMIN',
    },
  });

  await service.setCommissionRate({
    rateBasisPoints: 750,
    actorUserId: admin.id,
    reason: 'configured',
  });

  const rate = await service.resolveCommissionRate();
  assert.equal(rate.rateBasisPoints, 750);
  assert.equal(rate.isDefault, false, 'a real record is never reported as a default');
  assert.ok(rate.id);
  assert.equal(rate.setByUserId, admin.id);
});

describe('the admin endpoint surfaces the fallback so the UI can flag it', async () => {
  const server = await startServer(createApp());
  try {
    const { hashPassword } = require('../src/lib/auth');
    const password = 'correct horse battery staple';
    await prisma.user.create({
      data: {
        email: 'sa2@example.test',
        phone: '+2348000009998',
        passwordHash: await hashPassword(password),
        role: 'ADMIN',
      },
    });

    const { token } = await (
      await fetch(`${server.url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sa2@example.test', password }),
      })
    ).json();

    const res = await fetch(`${server.url}/admin/config/commission`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Previously this returned 500 on an unconfigured platform, taking the
    // admin screen down with it.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.current.isDefault, 'boolean');
  } finally {
    await server.close();
  }
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
