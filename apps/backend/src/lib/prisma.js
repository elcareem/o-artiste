/**
 * Prisma Client singleton.
 *
 * One instance per process. Instantiating per-request exhausts the connection
 * pool under load, and on a service that holds funding instructions a connection
 * failure mid-transaction is not a cheap error.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
});

module.exports = prisma;
