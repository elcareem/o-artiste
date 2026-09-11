/** Shared test helpers. */

/**
 * Binds an Express app to an ephemeral port and returns its base URL plus a
 * close function. Port 0 lets the OS pick, so tests never collide with a dev
 * server or with each other.
 */
function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startServer };
