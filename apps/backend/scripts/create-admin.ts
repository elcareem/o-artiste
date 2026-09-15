/**
 * Creates an ADMIN or SUPER_ADMIN account — the only supported way to make one.
 *
 * WHY THIS EXISTS. `POST /auth/register` whitelists CLIENT and ARTIST, on
 * purpose: there must be no public route to a privileged account (#9). That
 * left exactly two ways to create an admin on a deployed instance — run the
 * development seed, whose password is committed to this repository, or hand-
 * write a bcrypt hash into a SQL INSERT. The first is a vulnerability and the
 * second is how a typo becomes an account nobody can log into and nobody can
 * see.
 *
 *   npm run create-admin --workspace apps/backend
 *
 * THE PASSWORD IS NEVER A COMMAND-LINE ARGUMENT. argv lands in shell history,
 * in `ps` output for every user on the box, and in the scrollback of whatever
 * terminal is recording the session. It is prompted for, with echo suppressed.
 */

const path = require('node:path');
const readline = require('node:readline');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = require('../src/lib/prisma.ts');
const { hashPassword } = require('../src/lib/auth.ts');
const { SEED_PASSWORD } = require('../prisma/seed.ts');

/**
 * Long enough that an offline attack on the hash is not worth starting.
 *
 * bcrypt is deliberately slow, but this account can change the commission rate
 * on every future booking, so the threat model is someone with the database
 * and time — not someone guessing at the login form.
 */
const MIN_PASSWORD_LENGTH = 16;

async function main() {
  const superRequested = process.argv.includes('--super');

  // Checked first, and loudly. Everything below prompts, and a script that
  // silently does nothing when piped is worse than one that refuses: the first
  // version of this exited 0 without creating an account or saying why.
  if (!process.stdin.isTTY) {
    fail(
      'This script must be run at a terminal. It prompts for a password, and will not read one from a pipe, a file or an argument.'
    );
  }

  // ONE interface for the whole run. Creating a new one per question and
  // closing it ends `process.stdin`, so the second prompt never receives an
  // answer — the callback simply never fires and the process exits cleanly
  // having done nothing.
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log('');
  console.log('  Create an administrator');
  console.log('  ───────────────────────');
  console.log(`  Database: ${describeDatabase()}`);
  console.log('');

  const email = normaliseEmail(await ask('  Email: '));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail('That is not an email address.');
  }

  // Not a rule of the schema, a rule of operations: this address is how a
  // locked-out administrator is reached, so a domain nobody owns is a bad
  // account waiting to happen.
  if (/\.(test|local|invalid|example)$/.test(email.split('@')[1] ?? '')) {
    fail(
      `${email} is not a deliverable address. Use a mailbox you control — it is how this account is recovered.`
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    fail(
      `${email} already exists as ${existing.role}. This script never overwrites an account; delete it deliberately if that is what you mean.`
    );
  }

  const phone = normalisePhone(await ask('  Phone (E.164, e.g. +2348012345678): '));
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    fail('Phone must be E.164 — a leading + and 8 to 15 digits.');
  }
  if (await prisma.user.findUnique({ where: { phone } })) {
    fail(`${phone} is already registered.`);
  }

  const role = superRequested ? 'SUPER_ADMIN' : 'ADMIN';

  if (superRequested) {
    console.log('');
    console.log('  SUPER_ADMIN can change the commission rate and the cancellation');
    console.log('  tiers, which govern every booking created afterwards. ADMIN can');
    console.log('  resolve disputes and move money on a single booking, and cannot.');
    console.log('');
    const confirm = await ask(`  Type CREATE SUPER_ADMIN to confirm: `);
    if (confirm.trim() !== 'CREATE SUPER_ADMIN') fail('Not confirmed. Nothing was created.');
  }

  const password = await askSecret(`  Password (${MIN_PASSWORD_LENGTH}+ characters): `);
  const again = await askSecret('  Repeat it: ');

  if (password !== again) fail('The two passwords do not match.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Too short — ${password.length} characters, minimum ${MIN_PASSWORD_LENGTH}.`);
  }
  if (password === SEED_PASSWORD) {
    fail('That is the development seed password. It is committed to this repository.');
  }

  const passwordHash = await hashPassword(password);

  // The account and its audit row commit together. An administrator created
  // with no record of who created it is precisely the account an attacker
  // would want, and a table that can miss one cannot be used as evidence.
  const user = await prisma.$transaction(async (tx: PrismaTx) => {
    const created = await tx.user.create({
      data: {
        email,
        phone,
        passwordHash,
        role,
        // Identity verification exists to gate booking and being booked
        // (#10). An administrator does neither, and putting a real NIN through
        // the provider for an account that will never transact is a ₦50 charge
        // and an NDPR exposure for nothing.
        verificationStatus: 'UNVERIFIED',
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: 'ADMIN_ACCOUNT_CREATED',
        entityType: 'User',
        entityId: created.id,
        reason: 'Created via scripts/create-admin.ts',
        after: { email: created.email, role: created.role },
      },
    });

    return created;
  });

  console.log('');
  console.log(`  Created ${user.role}: ${user.email}`);
  console.log(`  id ${user.id}`);
  console.log('');
  console.log('  The password was not written anywhere. Put it in a password');
  console.log('  manager now — there is no reset flow yet (#38).');
  console.log('');
}

function describeDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return 'DATABASE_URL is not set';
  try {
    // Host and database only. The credentials in the string are not something
    // to print to a terminal that may be shared or recorded.
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

const normaliseEmail = (value: string) => value.trim().toLowerCase();
const normalisePhone = (value: string) => value.trim().replace(/[\s()-]/g, '');

let rl: any = null;

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Reads a line without echoing it.
 *
 * Node's readline has no built-in for this, so what the interface writes back
 * is suppressed for the duration. Not perfect — a terminal recorder still sees
 * the keystrokes — but it keeps the password off the screen and out of
 * scrollback, which is where it would otherwise sit for the rest of the day.
 */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const output = rl.output;
    const write = output.write.bind(output);
    let muted = false;

    rl._writeToOutput = (text: string) => {
      if (!muted) return write(text);
      // The prompt itself still prints; only what is typed after it is hidden.
      if (text.includes(question)) return write(question);
      return write('');
    };

    rl.question(question, (answer: string) => {
      muted = false;
      rl._writeToOutput = write;
      write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function fail(message: string): never {
  console.error('');
  console.error(`  ${message}`);
  console.error('');
  process.exit(1);
}

main()
  .catch((err: Error) => {
    console.error('');
    console.error(`  ${err.message}`);
    console.error('');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (rl) rl.close();
    await prisma.$disconnect();
  });
