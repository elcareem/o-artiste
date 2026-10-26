/**
 * Payout account proxy — issue #44.
 *
 * The account number passes through to the backend, which sends it to the
 * provider and keeps only the last four digits. Nothing here logs or stores it.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { bankCode, accountNumber, accountName } = body;

  return forwardAuthenticated('/artists/me/payout-account', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankCode, accountNumber, accountName }),
  });
}
