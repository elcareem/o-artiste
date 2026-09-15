/**
 * Body parsing — docs/03-ESCROW-FLOW.md §6.
 *
 * JSON everywhere, EXCEPT under /webhooks/* where the raw bytes are preserved.
 *
 * This exists because webhook signature verification runs against the exact
 * bytes received. express.json() parses and re-serialises, which changes key
 * order and whitespace, and the signature then no longer matches.
 *
 * It is configured here at bootstrap rather than retrofitted at #20 on purpose:
 * without it the failure surfaces only during integration testing, and it looks
 * like a provider problem rather than one of ours.
 *
 * A single branching middleware is used rather than mounting express.json()
 * after a /webhooks router, because the mount order that makes that work is
 * easy to break later with an innocuous-looking refactor. This way the
 * exception is stated once, explicitly, in one place.
 */

const express = require('express');

const WEBHOOK_PREFIX = '/webhooks';
const LIMIT = '1mb';

function bodyParsers() {
  const raw = express.raw({ type: () => true, limit: LIMIT });
  const json = express.json({ limit: LIMIT });

  return function parseBody(req: Req, res: Res, next: Next) {
    if (isWebhookPath(req.path)) {
      return raw(req, res, next);
    }
    return json(req, res, next);
  };
}

/**
 * Matches /webhooks and anything beneath it, but not a path that merely starts
 * with those characters — /webhooksomething is not a webhook path.
 */
function isWebhookPath(path: string): boolean {
  return path === WEBHOOK_PREFIX || path.startsWith(`${WEBHOOK_PREFIX}/`);
}

module.exports = { bodyParsers, isWebhookPath, WEBHOOK_PREFIX };
