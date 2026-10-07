import { useEffect, useState } from 'react';
import { formatDate, formatRupees } from '../api/client';
import { getAdminReport, type AdminReport } from '../api/endpoints';
import { Card, ErrorAlert, Loading, Stat } from '../components/ui';

const RANGES = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
] as const;

export function AdminReports() {
  const [report, setReport] = useState<AdminReport | null>(null);
  const [days, setDays] = useState<string>('30');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - Number(days) * 86_400_000);
      setReport(await getAdminReport({ from: from.toISOString(), to: to.toISOString() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (loading) return <Loading label="Building report…" />;
  if (error && !report) return <ErrorAlert error={error} onRetry={() => void load()} />;
  if (!report) return null;

  const committed = report.totalBookings - report.lostBookings;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            {formatDate(report.range.from)} to {formatDate(report.range.to)}
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`btn btn-sm ${days === r.key ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setDays(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}

      <div className="stat-grid">
        <Stat
          label="Bookings created"
          value={report.totalBookings}
          tone="brand"
          hint={`${committed} not cancelled`}
        />
        <Stat
          label="Cancellation rate"
          value={`${report.cancellationRate}%`}
          tone={report.cancellationRate > 30 ? 'danger' : report.cancellationRate > 15 ? 'warning' : 'success'}
          hint={`${report.lostBookings} lost`}
        />
        <Stat label="Gross rent booked" value={formatRupees(report.totals.grossRentPaise)} />
        <Stat
          label="Commission retained"
          value={formatRupees(report.totals.commissionPaise)}
          tone="success"
          hint={
            report.totals.grossRentPaise > 0
              ? `${((report.totals.commissionPaise / report.totals.grossRentPaise) * 100).toFixed(1)}% of gross`
              : undefined
          }
        />
        <Stat
          label="Deposits held"
          value={formatRupees(report.totals.depositPaise)}
          hint="Student money, not revenue"
        />
        <Stat label="New owners" value={report.growth.newOwners} />
        <Stat label="New students" value={report.growth.newStudents} tone="info" />
      </div>

      {report.cancellationRate > 30 ? (
        <div className="alert error">
          <strong>High cancellation rate ({report.cancellationRate}%).</strong> Above roughly 30% usually means
          the bed-hold window or the owner approval step is failing students, rather than normal churn.
        </div>
      ) : null}

      <Card title="Booking funnel">
        <table className="table">
          <tbody>
            {Object.entries(report.bookingsByStatus)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => (
                <tr key={status}>
                  <td style={{ textTransform: 'capitalize' }}>{status.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {count}
                  </td>
                  <td className="num muted small">
                    {report.totalBookings > 0 ? Math.round((count / report.totalBookings) * 100) : 0}%
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      <Card title="Top properties">
        {report.topHostels.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No confirmed bookings in this range</div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Area</th>
                <th className="num">Bookings</th>
                <th className="num">Owner payout</th>
                <th className="num">Commission</th>
              </tr>
            </thead>
            <tbody>
              {report.topHostels.map((h) => (
                <tr key={h.hostelId}>
                  <td style={{ fontWeight: 600 }}>{h.name}</td>
                  <td className="muted">{h.area}</td>
                  <td className="num">{h.bookings}</td>
                  <td className="num">{formatRupees(h.payoutPaise)}</td>
                  <td className="num" style={{ color: 'var(--success)' }}>
                    {formatRupees(h.commissionPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`Colleges with listings (${report.colleges.length})`}>
        <table className="table">
          <thead>
            <tr>
              <th>College</th>
              <th className="num">Hostels</th>
            </tr>
          </thead>
          <tbody>
            {report.colleges.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num">{c.hostelCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}