/**
 * Server entry point.
 *
 * Loads environment configuration, then binds. Application assembly lives in
 * app.js so it can be exercised by tests without a listening socket.
 */

require('dotenv').config();

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[backend] listening on :${PORT}`);
  console.log(`[backend] cors origin ${process.env.WEB_ORIGIN || 'http://localhost:3000'}`);
});

// Render and most process hosts send SIGTERM on deploy and on shutdown. Closing
// the server lets in-flight requests finish instead of being cut mid-response —
// which matters here, because a request cut mid-flight can be one that has
// already instructed a money movement.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[backend] ${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}

module.exports = { server };
