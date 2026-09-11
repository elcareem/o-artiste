/**
 * The unified error contract — docs/02-API-CONTRACT.md §2.
 *
 * Every error response in this API is exactly `{ "error": "..." }` with an
 * appropriate status. No error codes, no nested detail objects, no stack
 * traces, no arrays of validation objects. One string, written for a person.
 *
 * Route handlers throw AppError; the terminal middleware below serialises it.
 * Handlers must never build an error response by hand — that is how shape
 * drift starts, and the frontend renders the `error` string directly and
 * unaltered, so the backend owns the wording.
 */

class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} message User-facing copy. Name what went wrong and, where
   *   possible, what to do about it. "Validation failed" is not acceptable.
   */
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.expected = true;
  }
}

/** Nothing matched — turn it into the same shape as everything else. */
function notFoundHandler(req, res, next) {
  next(new AppError(404, 'Not found.'));
}

/**
 * Terminal error middleware. Must be registered last, and must keep all four
 * parameters — Express identifies error handlers by arity.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }

  // A malformed JSON body surfaces here as a SyntaxError from express.json().
  // It is a client error, not ours, and deserves a message that says so.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }

  // Anything else is a bug. The detail goes to the logs; the client gets a
  // generic message. Leaking an internal error to a user staring at a payment
  // screen tells them nothing and worries them a great deal.
  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Something went wrong on our end.' });
}

module.exports = { AppError, notFoundHandler, errorHandler };
