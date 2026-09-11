/**
 * Backend API client — docs/02-API-CONTRACT.md.
 *
 * The frontend talks to our backend and nothing else. It never calls EscrowPay,
 * never loads a provider SDK, and never holds a provider key
 * (docs/03-ESCROW-FLOW.md §8).
 *
 * All monetary values crossing this boundary are kobo integers. Nothing here
 * converts them; conversion happens only in formatNaira() at render time.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * An error carrying the backend's own message.
 *
 * The unified error shape is `{ "error": "..." }`, and that string is written
 * for a person by the backend. The UI renders it directly and unaltered — it
 * does not map, rewrite, or prefix it. Anything else produces two divergent
 * sets of wording for the same condition.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Copy shown when the request never reached the API at all. */
const NETWORK_MESSAGE =
  'Could not reach the server. Check your connection and try again.';

/** Copy shown when the API failed without a usable message of its own. */
const UNKNOWN_MESSAGE = 'Something went wrong. Please try again.';

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

/**
 * Performs a request and returns the parsed JSON body.
 *
 * On a non-2xx response this throws an ApiError carrying the backend's `error`
 * string, so callers can render `error.message` straight into the UI.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, headers, ...rest } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // fetch only rejects on a genuine network failure, which is a different
    // problem from the server rejecting the request, and needs different copy.
    throw new ApiError(0, NETWORK_MESSAGE);
  }

  const payload = await readJson(response);

  if (!response.ok) {
    const message =
      isErrorShape(payload) && payload.error.trim().length > 0
        ? payload.error
        : UNKNOWN_MESSAGE;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isErrorShape(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  );
}

/** Liveness check against the backend. */
export function getHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>('/health');
}

export { BASE_URL };
