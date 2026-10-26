/**
 * Express application assembly.
 *
 * Separated from index.js so tests can build an app without binding a port.
 */

const express = require('express');
const cors = require('cors');

const { bodyParsers } = require('./lib/bodyParsers.ts');
const { healthPayload } = require('./lib/version.ts');
const { notFoundHandler, errorHandler } = require('./lib/errors.ts');
const { router: authRouter } = require('./routes/auth.ts');
const { router: adminRouter } = require('./routes/admin.ts');
const { router: verificationRouter } = require('./routes/verification.ts');
const { router: artistsRouter } = require('./routes/artists.ts');
const { router: bookingsRouter } = require('./routes/bookings.ts');
const { router: queueRouter } = require('./routes/queue.ts');
const { router: webhooksRouter } = require('./routes/webhooks.ts');
const { requireAuth, requireRole } = require('./middleware/auth.ts');

/**
 * How many proxies sit between the client and us. Render has exactly one, and
 * sets `RENDER=true` on its services; anywhere else it is zero unless said.
 */
function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw !== undefined && raw !== '') {
    const hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(`TRUST_PROXY_HOPS must be a whole number of proxies, 0 or more — received "${raw}".`);
    }
    return hops;
  }
  return process.env.RENDER === 'true' ? 1 : 0;
}

function createApp() {
  const app = express();

  // Nothing gains from advertising the framework.
  app.disable('x-powered-by');

  // WHO IS ACTUALLY CALLING. Behind Render's proxy `req.ip` is the PROXY's
  // address unless Express is told to trust it, which meant two things before
  // #41: every terms acknowledgement (#16) recorded Render's address as the
  // client's — evidence that identifies nobody — and an IP-based rate limit
  // would have throttled every user as one.
  //
  // Not trusted by default anywhere else: with no proxy in front, trusting one
  // lets a caller set their own `req.ip` through X-Forwarded-For.
  app.set('trust proxy', trustProxyHops());

  app.use(cors({ origin: webOrigin(), credentials: true }));

  // Raw under /webhooks/*, JSON everywhere else. See lib/bodyParsers.js.
  app.use(bodyParsers());

  /**
   * Liveness. Deliberately has no database or Redis dependency — it must still
   * answer while a dependency is down, or it cannot distinguish a dead process
   * from a dead dependency. docs/02-API-CONTRACT.md §11.
   */
  // Alive, and WHICH BUILD. The commit is what makes a deploy verifiable from
  // outside; without it "did that merge actually ship?" is answered by poking
  // at routes and inferring. Deliberately says nothing about dependencies —
  // that is `/admin/diagnostics`, behind a token.
  app.get('/health', (req: Req, res: Res) => {
    res.json(healthPayload());
  });

  app.use(authRouter);
  app.use(adminRouter);
  app.use(verificationRouter);
  app.use(artistsRouter);
  app.use(bookingsRouter);
  app.use(queueRouter);

  // Raw-bodied, signature-authenticated. See routes/webhooks.js.
  app.use(webhooksRouter);

  // Role-guarded endpoints. Each exists because a later issue needs it, and
  // each is the endpoint #9's "blocked from at least one endpoint above its
  // level" criterion is verified against.
  app.get('/admin/ping', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), (req: AuthedReq, res: Res) => {
    res.json({ status: 'ok', role: req.user.role });
  });

  // Must stay last, and in this order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * The browser origin permitted to call this API. Defaults to the local web dev
 * server so a fresh checkout works without configuration; set WEB_ORIGIN in
 * every deployed environment.
 */
function webOrigin() {
  return process.env.WEB_ORIGIN || 'http://localhost:3000';
}

module.exports = { createApp, trustProxyHops };
