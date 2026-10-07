import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatRupees } from '../api/client';
import {
  getOwnerDashboard,
  listOwnerBookings,
  type Booking,
  type OwnerDashboard,
  type User,
} from '../api/endpoints';
import { Badge, Card, Empty, ErrorAlert, Loading, Stat, StatusBadge } from '../components/ui';

export function OwnerOverview({ user }: { user: User }) {
  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [pending, setPending] = useState<Booking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dash, bookings] = await Promise.all([
        getOwnerDashboard(),
        listOwnerBookings('PENDING_OWNER'),
      ]);
      setDashboard(dash);
      setPending(bookings.bookings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <Loading label="Loading your dashboard…" />;
  if (error) return <ErrorAlert error={error} onRetry={() => void load()} />;
  if (!dashboard) return null;

  const occupancy =
    dashboard.beds.total > 0
      ? Math.round((dashboard.beds.occupied / dashboard.beds.total) * 1000) / 10
      : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Welcome back, {user.name.split(' ')[0]}</h1>
          <p className="page-sub">Here is how your properties are doing.</p>
        </div>
        <Link className="btn btn-primary" to="/properties">
          Manage properties
        </Link>
      </div>

      {/* Verification is the gate on everything else, so it is shown first. */}
      {dashboard.verificationStatus !== 'APPROVED' ? (
        <div className={`alert ${dashboard.verificationStatus === 'REJECTED' ? 'error' : 'warning'}`}>
          <strong>
            {dashboard.verificationStatus === 'REJECTED'
              ? 'Your verification was rejected. '
              : 'Your account is awaiting verification. '}
          </strong>
          Properties stay hidden from students until verification is approved. Admins review the documents
          you uploaded from the owner dashboard.
        </div>
      ) : null}

      <div className="stat-grid">
        <Stat
          label="Needs your response"
          value={dashboard.pendingApprovals}
          tone={dashboard.pendingApprovals > 0 ? 'warning' : undefined}
          hint={dashboard.pendingApprovals > 0 ? 'Students are waiting' : 'All caught up'}
        />
        <Stat
          label="Currently checked in"
          value={dashboard.currentlyCheckedIn}
          tone="info"
          hint="Occupied beds right now"
        />
        <Stat
          label="Occupancy"
          value={`${occupancy}%`}
          tone="brand"
          hint={`${dashboard.beds.occupied} of ${dashboard.beds.total} beds`}
        />
        <Stat
          label="Your commission rate"
          value={`${(dashboard.commissionRateBps / 100).toFixed(1)}%`}
          hint={user.ownerProfile?.commissionOverrideBps != null ? 'Custom rate' : 'Platform default'}
        />
      </div>

      <Card title="Earnings">
        <div className="grid-2">
          <div>
            <div className="stat-label">Gross rent booked</div>
            <div className="stat-value">{formatRupees(dashboard.earnings.grossPaise)}</div>
          </div>
          <div>
            <div className="stat-label">You receive</div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>
              {formatRupees(dashboard.earnings.payoutPaise)}
            </div>
          </div>
        </div>

        <table className="table" style={{ marginTop: 14 }}>
          <tbody>
            <tr>
              <td>Rent and charges across {dashboard.earnings.bookingCount} booking(s)</td>
              <td className="num">{formatRupees(dashboard.earnings.grossPaise)}</td>
            </tr>
            <tr>
              <td>Platform commission</td>
              <td className="num" style={{ color: 'var(--danger)' }}>
                −{formatRupees(dashboard.earnings.commissionPaise)}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Net payout</strong>
              </td>
              <td className="num">
                <strong style={{ color: 'var(--primary)' }}>{formatRupees(dashboard.earnings.payoutPaise)}</strong>
              </td>
            </tr>
          </tbody>
        </table>

        {dashboard.earnings.depositHeldPaise > 0 ? (
          <div className="alert info" style={{ marginTop: 14, marginBottom: 0 }}>
            <strong>{formatRupees(dashboard.earnings.depositHeldPaise)}</strong> in student security deposits is
            held separately from your earnings. It is not your revenue and is refunded to students on checkout.
          </div>
        ) : null}
      </Card>

      <Card
        title="Awaiting your response"
        actions={
          <Link className="btn btn-outline btn-sm" to="/bookings">
            All bookings
          </Link>
        }
      >
        {pending.length === 0 ? (
          <Empty title="Nothing pending" message="New booking requests appear here for you to accept or decline." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Property</th>
                <th>Bed</th>
                <th>Stay</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((b) => (
                <tr key={b.bookingRef}>
                  <td className="mono">{b.bookingRef}</td>
                  <td>{b.hostel.name}</td>
                  <td>{b.bed.label}</td>
                  <td>{b.stayType === 'MONTHLY' ? `${b.months}mo` : `${b.days}d`}</td>
                  <td className="num">{formatRupees(b.totalAmount)}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Your properties">
        {dashboard.hostels.length === 0 ? (
          <Empty icon="🏢" title="No properties yet" message="Add your first property to start receiving bookings." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Review status</th>
                <th>Visibility</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.hostels.map((h) => (
                <tr key={h.id}>
                  <td>{h.name}</td>
                  <td>
                    <Badge tone={h.verificationStatus === 'APPROVED' ? 'success' : 'warning'}>
                      {h.verificationStatus}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={h.published ? 'brand' : 'neutral'}>{h.published ? 'Live' : 'Not listed'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}