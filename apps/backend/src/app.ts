/**
 * Express application assembly.
 *
 * Separated from index.js so tests can build an app without binding a port.
 */

const express = require('express');
const cors = require('cors');

const { bodyParsers } = require('./lib/bodyParsers.ts');
const { notFoundHandler, errorHandler } = require('./lib/errors.ts');
const { router: authRouter } = require('./routes/auth.ts');
const { router: adminRouter } = require('./routes/admin.ts');
const { router: verificationRouter } = require('./routes/verification.ts');
const { router: artistsRouter } = require('./routes/artists.ts');
const { router: bookingsRouter } = require('./routes/bookings.ts');
const { router: webhooksRouter } = require('./routes/webhooks.ts');
const { requireAuth, requireRole } = require('./middleware/auth.ts');

function createApp() {
  const app = express();

  // Nothing gains from advertising the framework.
  app.disable('x-powered-by');

  app.use(cors({ origin: webOrigin(), credentials: true }));

  // Raw under /webhooks/*, JSON everywhere else. See lib/bodyParsers.js.
  app.use(bodyParsers());

  /**
   * Liveness. Deliberately has no database or Redis dependency — it must still
   * answer while a dependency is down, or it cannot distinguish a dead process
   * from a dead dependency. docs/02-API-CONTRACT.md §11.
   */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(authRouter);
  app.use(adminRouter);
  app.use(verificationRouter);
  app.use(artistsRouter);
  app.use(bookingsRouter);

  // Raw-bodied, signature-authenticated. See routes/webhooks.js.
  app.use(webhooksRouter);

  // Role-guarded endpoints. Each exists because a later issue needs it, and
  // each is the endpoint #9's "blocked from at least one endpoint above its
  // level" criterion is verified against.
  app.get('/admin/ping', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), (req, res) => {
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

module.exports = { createApp };
