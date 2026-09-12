/**
 * Webhook endpoints — issue #20.
 *
 * Deliberately thin. Everything that decides anything lives in
 * `services/webhookService.js`, so the retry job and the live delivery take the
 * same code path rather than two that can drift apart.
 *
 * MOUNTED UNDER /webhooks, WHICH IS WHERE `lib/bodyParsers.js` PRESERVES THE
 * RAW BYTES. `req.body` here is a Buffer, not an object, and it must stay one:
 * signature verification runs against the exact bytes received, and
 * `express.json()` anywhere on this path re-serialises them and silently breaks
 * every signature. The failure then looks like a provider fault.
 *
 * No authentication middleware. The signature IS the authentication, and it is
 * stronger than a bearer token here because it also covers the body.
 */

const express = require('express');

const webhookService = require('../services/webhookService');
const { AppError } = require('../lib/errors');

const router = express.Router();

router.post('/webhooks/escrowpay', async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      // The raw-body exception has been broken by a middleware change. Fail
      // loudly: verifying a re-serialised body would either reject every real
      // delivery or, written permissively, accept forged ones.
      console.error('[webhook] raw body missing — the /webhooks body-parser exception is broken');
      throw new AppError(500, 'Something went wrong on our end.');
    }

    const { status, body } = await webhookService.receive({
      rawBody: req.body,
      headers: req.headers,
    });

    return res.status(status).json(body);
  } catch (err) {
    return next(err);
  }
});

module.exports = { router };
