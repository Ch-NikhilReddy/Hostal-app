import { useEffect, useState } from 'react';
import { formatDate, formatRupees } from '../api/client';
import { listOwnerBookings, respondToBooking, setLifecycle, type Booking } from '../api/endpoints';
import { Badge, Card, Empty, ErrorAlert, Loading, ReasonDialog, StatusBadge } from '../components/ui';

/**
 * Owner booking queue.
 *
 * Split by what the owner must DO, not by database status, because the two
 * questions an owner has are "what needs my answer" and "what is happening now".
 */
const FILTERS = [
  { key: 'PENDING_OWNER', label: 'Needs response' },
  { key: 'CONFIRMED', label: 'Confirmed' },
  { key: 'CHECKED_IN', label: 'Checked in' },
  { key: '', label: 'All' },
] as const;

/** The statuses that are still live (not cancelled, refunded or expired). */
const ACTIVE_STATUSES = ['PENDING_OWNER', 'CONFIRMED', 'CHECKED_IN'];

export function OwnerBookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [filter, setFilter] = useState<string>('PENDING_OWNER');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await listOwnerBookings(filter || undefined);
      setBookings(res.bookings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bookings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function act(bookingRef: string, fn: () => Promise<unknown>) {
    setBusyRef(bookingRef);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action failed.');
    } finally {
      setBusyRef(null);
    }
  }

  /** Badge counts come from the unfiltered "All" view, so the tab labels stay
      accurate even while a different filter is active. */
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    listOwnerBookings()
      .then((res) => {
        const counts: Record<string, number> = {};
        for (const b of res.bookings) counts[b.status] = (counts[b.status] ?? 0) + 1;
        setTabCounts(counts);
      })
      .catch(() => undefined);
  }, [bookings]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Bookings</h1>
          <p className="page-sub">Accept or decline requests, and record arrivals and departures.</p>
        </div>
      </div>

      {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}

      <div className="row" style={{ marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const count = f.key ? (tabCounts[f.key] ?? 0) : null;
          return (
            <button
              key={f.key || 'all'}
              className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {count !== null && count > 0 ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      {loading ? (
        <Loading label="Loading bookings…" />
      ) : bookings.length === 0 ? (
        <Card>
          <Empty
            icon="📋"
            title={filter === 'PENDING_OWNER' ? 'Nothing waiting on you' : 'No bookings'}
            message={
              filter === 'PENDING_OWNER'
                ? 'New requests will appear here. Students are notified as soon as you respond.'
                : 'Bookings matching this filter will appear here.'
            }
          />
        </Card>
      ) : (
        <Card title={`${bookings.length} booking${bookings.length === 1 ? '' : 's'}`}>
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Property</th>
                <th>Room / bed</th>
                <th>Stay</th>
                <th>Dates</th>
                <th className="num">Your payout</th>
                <th className="num">Student paid</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => {
                const busy = busyRef === b.bookingRef;
                return (
                  <tr key={b.bookingRef}>
                    <td className="mono">{b.bookingRef}</td>
                    <td>{b.hostel.name}</td>
                    <td>
                      {b.roomType.name}
                      <div className="small muted">Bed {b.bed.label}</div>
                    </td>
                    <td>{b.stayType === 'MONTHLY' ? `${b.months}mo` : `${b.days}d`}</td>
                    <td className="small">
                      {formatDate(b.checkIn)}
                      <div className="muted">→ {formatDate(b.checkOut)}</div>
                    </td>
                    {/* Payout excludes the deposit, which is the student's money. */}
                    <td className="num" style={{ color: 'var(--success)', fontWeight: 600 }}>
                      {formatRupees(b.ownerPayout)}
                    </td>
                    <td className="num">{formatRupees(b.totalAmount)}</td>
                    <td>
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="right">
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        {b.status === 'PENDING_OWNER' ? (
                          <>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy}
                              onClick={() => void act(b.bookingRef, () => respondToBooking(b.bookingRef, 'accept'))}
                            >
                              Accept
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busy}
                              onClick={() => setDeclining(b.bookingRef)}
                            >
                              Decline
                            </button>
                          </>
                        ) : null}

                        {b.status === 'CONFIRMED' ? (
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={busy}
                            onClick={() => void act(b.bookingRef, () => setLifecycle(b.bookingRef, 'check-in'))}
                          >
                            Check in
                          </button>
                        ) : null}

                        {b.status === 'CHECKED_IN' ? (
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={busy}
                            onClick={() => void act(b.bookingRef, () => setLifecycle(b.bookingRef, 'check-out'))}
                          >
                            Check out
                          </button>
                        ) : null}

                        {!ACTIVE_STATUSES.includes(b.status) ? <Badge tone="neutral">—</Badge> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <ReasonDialog
        open={declining !== null}
        title="Decline this booking?"
        label="Reason shown to the student"
        confirmLabel="Decline booking"
        onCancel={() => setDeclining(null)}
        onSubmit={(reason) => {
          const ref = declining;
          setDeclining(null);
          if (ref) void act(ref, () => respondToBooking(ref, 'decline', reason));
        }}
      />
    </>
  );
}