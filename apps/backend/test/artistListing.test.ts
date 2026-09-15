/**
 * Public artist listing and detail — issue #12.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('artistlisting');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/** A fully listable artist unless told otherwise. */
async function makeArtist({
  verified = true,
  standing = 'GOOD',
  complete = true,
  category = 'Afrobeats',
  location = 'Lagos',
} = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const user = await prisma.user.create({
    data: {
      email: `list${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role: 'ARTIST',
      verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
      accountStanding: standing,
    },
  });
  return prisma.artist.create({
    data: {
      userId: user.id,
      stageName: `Artist ${n}`,
      bio: 'A bio.',
      category: complete ? category : null,
      location: complete ? location : null,
      baseRateKobo: complete ? 5000000 : null,
      profileComplete: complete,
    },
  });
}

async function withServer(fn) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

const get = (server, path) => fetch(`${server.url}${path}`);

// ---------------------------------------------------------------------------

describe('GET /artists returns 200 with a paginated payload, unauthenticated', async () => {
  await withServer(async (server) => {
    await makeArtist();
    await makeArtist();

    // No Authorization header at all — discovery is public.
    const res = await get(server, '/artists');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.artists));
    assert.ok(body.artists.length >= 2);

    assert.deepEqual(Object.keys(body.pagination).sort(), ['limit', 'page', 'total', 'totalPages']);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 20);
    assert.ok(body.pagination.total >= 2);
  });
});

describe('cancellationRate is PRESENT and null, never omitted', async () => {
  await withServer(async (server) => {
    const artist = await makeArtist();

    for (const path of ['/artists', `/artists/${artist.id}`]) {
      const body = await (await get(server, path)).json();
      const subject = path === '/artists' ? body.artists.find((a) => a.id === artist.id) : body.artist;

      // `in` rather than a truthiness check: the field existing and being null
      // is the contract. Omitting it would let #13 forget the case exists.
      assert.ok('cancellationRate' in subject, `${path}: the field must be present`);
      assert.equal(subject.cancellationRate, null, `${path}: null until #35 populates it`);
    }
  });
});

describe('a suspended artist does not appear in the listing and returns 404 on detail', async () => {
  await withServer(async (server) => {
    const visible = await makeArtist();
    const suspended = await makeArtist({ standing: 'SUSPENDED' });

    const body = await (await get(server, '/artists?limit=100')).json();
    const ids = body.artists.map((a) => a.id);

    assert.ok(ids.includes(visible.id), 'a good-standing artist is listed');
    assert.ok(!ids.includes(suspended.id), 'a suspended artist must never appear');

    // 404, not 403 — distinguishing them would confirm the account exists.
    const detail = await get(server, `/artists/${suspended.id}`);
    assert.equal(detail.status, 404);
    assert.deepEqual(Object.keys(await detail.json()), ['error']);
  });
});

describe('unverified, removed and incomplete artists are excluded too', async () => {
  await withServer(async (server) => {
    const excluded = [
      await makeArtist({ verified: false }),
      await makeArtist({ standing: 'REMOVED' }),
      await makeArtist({ complete: false }),
    ];
    const included = await makeArtist();

    const body = await (await get(server, '/artists?limit=100')).json();
    const ids = body.artists.map((a) => a.id);

    assert.ok(ids.includes(included.id));
    for (const artist of excluded) {
      assert.ok(!ids.includes(artist.id), `${artist.id} must not be listed`);
      assert.equal((await get(server, `/artists/${artist.id}`)).status, 404);
    }
  });
});

describe('filtering by category and location', async () => {
  await withServer(async (server) => {
    const afro = await makeArtist({ category: 'Afrobeats', location: 'Lagos' });
    const dj = await makeArtist({ category: 'DJ', location: 'Abuja' });

    const byCategory = await (await get(server, '/artists?category=DJ&limit=100')).json();
    const catIds = byCategory.artists.map((a) => a.id);
    assert.ok(catIds.includes(dj.id));
    assert.ok(!catIds.includes(afro.id));

    // Case-insensitive, so a filter chip does not have to match storage casing.
    const lowercase = await (await get(server, '/artists?category=dj&limit=100')).json();
    assert.ok(lowercase.artists.map((a) => a.id).includes(dj.id));

    const byLocation = await (await get(server, '/artists?location=Abuja&limit=100')).json();
    const locIds = byLocation.artists.map((a) => a.id);
    assert.ok(locIds.includes(dj.id));
    assert.ok(!locIds.includes(afro.id));

    // A filter matching nothing is an empty page, not an error — #13 renders a
    // readable empty state from this.
    const none = await (await get(server, '/artists?category=Polka')).json();
    assert.deepEqual(none.artists, []);
    assert.equal(none.pagination.total, 0);
    assert.equal(none.pagination.totalPages, 1);
  });
});

describe('pagination is bounded and behaves at the edges', async () => {
  await withServer(async (server) => {
    for (let i = 0; i < 3; i++) await makeArtist({ category: 'Paged' });

    const first = await (await get(server, '/artists?category=Paged&limit=2&page=1')).json();
    assert.equal(first.artists.length, 2);
    assert.equal(first.pagination.total, 3);
    assert.equal(first.pagination.totalPages, 2);

    const second = await (await get(server, '/artists?category=Paged&limit=2&page=2')).json();
    assert.equal(second.artists.length, 1);

    // Pages do not overlap.
    const overlap = first.artists.filter((a) => second.artists.some((b) => b.id === a.id));
    assert.equal(overlap.length, 0);

    // Nonsense input is clamped rather than erroring, and the cap holds so a
    // caller cannot ask for the whole table.
    const clamped = await (await get(server, '/artists?limit=9999&page=-5')).json();
    assert.equal(clamped.pagination.limit, 100);
    assert.equal(clamped.pagination.page, 1);

    const beyond = await (await get(server, '/artists?category=Paged&limit=2&page=99')).json();
    assert.deepEqual(beyond.artists, []);
  });
});

describe('the public shape leaks nothing private', async () => {
  await withServer(async (server) => {
    const artist = await makeArtist();
    const body = await (await get(server, `/artists/${artist.id}`)).json();
    const serialised = JSON.stringify(body);

    for (const leaked of ['userId', 'passwordHash', 'email', 'phone', 'profileComplete']) {
      assert.ok(!serialised.includes(leaked), `${leaked} must not appear in a public payload`);
    }

    // Rate stays a kobo integer — no formatting in the API.
    assert.equal(typeof body.artist.baseRateKobo, 'number');
    assert.ok(!serialised.includes('₦'));
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
