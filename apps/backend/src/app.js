/**
 * Express application assembly.
 *
 * Separated from index.js so tests can build an app without binding a port.
 */

const express = require('express');
const cors = require('cors');

const { bodyParsers } = require('./lib/bodyParsers');
const { notFoundHandler, errorHandler } = require('./lib/errors');

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
