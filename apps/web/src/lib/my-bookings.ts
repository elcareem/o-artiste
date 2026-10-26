/**
 * Where each action on "My bookings" leads — issue #45.
 *
 * The backend decides WHAT is needed (`action.code`); this decides only which
 * page does it. Kept out of the component so the mapping is tested.
 */

export type MyBooking = {
  id: string;
  state: string;
  amountKobo: number;
  eventDate: string;
  eventEndAt: string | null;
  eventLocation: string | null;
  counterparty: { name: string; artistId: string | null };
  action: { code: string; label: string; deadline?: string | null } | null;
  group: 'attention' | 'upcoming' | 'past';
};

export function hrefFor(booking: Pick<MyBooking, 'id' | 'action'>): string {
  switch (booking.action?.code) {
    case 'CHECK_IN':
      return `/check-in/${booking.id}`;
    case 'ACCEPT_TERMS':
      return `/bookings/${booking.id}/terms`;
    default:
      // Paying, confirming and disputes all happen on the booking's own page.
      return `/booking-status/${booking.id}`;
  }
}

export const GROUP_TITLES: Record<MyBooking['group'], string> = {
  attention: 'Needs your attention',
  upcoming: 'Coming up',
  past: 'Past',
};
