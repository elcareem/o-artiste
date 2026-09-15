/**
 * Types for the test harness.
 *
 * Global, for the same reason `src/types.d.ts` is: every test file is CommonJS
 * with no top-level import, so declarations here are visible without adding an
 * import to twenty-four files.
 */

/** What `startServer(app)` hands back. */
interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** The per-file schema harness from `test/db.ts`. */
interface TestDb {
  /** `null` when DATABASE_URL is unset — the caller then skips its tests. */
  prisma: import('@prisma/client').PrismaClient;
  hasDatabase: boolean;
  schema: string | null;
  ready?: Promise<unknown>;
}

/**
 * An error as seen inside an `assert.rejects` predicate.
 *
 * Deliberately loose: these callbacks reach for `status`, `message`, `code` and
 * provider fields across different error types, and a union precise enough to
 * cover all of them would be noise in a test that is asserting one property.
 */
type ThrownError = Error & {
  status?: number;
  code?: string;
  providerStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  [key: string]: any;
};
