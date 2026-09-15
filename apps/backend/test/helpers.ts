/** Shared test helpers. */

/**
 * Binds an Express app to an ephemeral port and returns its base URL plus a
 * close function. Port 0 lets the OS pick, so tests never collide with a dev
 * server or with each other.
 */
function startServer(app: import('express').Express): Promise<TestServer> {
  return new Promise<TestServer>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as import('node:net').AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startServer };
