import { useEffect, useState } from 'react';
import { formatDate, formatRupees } from '../api/client';
import {
  getSettlement,
  listOwners,
  verifyOwner,
  type Owner,
  type VerificationStatus,
} from '../api/endpoints';
import { Badge, Card, Empty, ErrorAlert, Loading, ReasonDialog } from '../components/ui';

const STATUS_TABS: { key: VerificationStatus | ''; label: string }[] = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: '', label: 'All' },
];

/**
 * Admin owner verification.
 *
 * The two rules that protect the platform:
 *   - an owner with zero uploaded documents cannot be approved (server enforces this,
 *     and the Approve button is disabled to match);
 *   - suspending an owner immediately unpublishes their properties.
 */
export function AdminVerification() {
  const [owners, setOwners] = useState<Owner[]>([]);
  const [status, setStatus] = useState<VerificationStatus | ''>('PENDING');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Owner | null>(null);
  const [settlement, setSettlement] = useState<{
    owner: Owner;
    rows: Awaited<ReturnType<typeof getSettlement>>['bookings'];
  } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listOwners({ status: status || undefined, search: search || undefined });
      setOwners(res.owners);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load owners.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function act(ownerId: string, next: 'APPROVED' | 'REJECTED' | 'SUSPENDED', reason?: string) {
    setBusyId(ownerId);
    setError(null);
    try {
      await verifyOwner(ownerId, next, reason);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function showSettlement(owner: Owner) {
    setError(null);
    try {
      const res = await getSettlement(owner.id);
      setSettlement({ owner, rows: res.bookings });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the settlement.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Owner verification</h1>
          <p className="page-sub">
            Approve owners before their listings go live. Suspending an owner immediately unpublishes their
            properties.
          </p>
        </div>
      </div>

      {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}

      <div className="row" style={{ marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key || 'all'}
            className={`btn btn-sm ${status === tab.key ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setStatus(tab.key)}
          >
            {tab.label}
          </button>
        ))}
        <input
          className="input"
          style={{ maxWidth: 260, marginLeft: 'auto' }}
          placeholder="Search name or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load()}
        />
        <button className="btn btn-outline btn-sm" onClick={() => void load()}>
          Search
        </button>
      </div>

      {loading ? (
        <Loading label="Loading owners…" />
      ) : owners.length === 0 ? (
        <Card>
          <Empty icon="✅" title="Queue is clear" message="No owners match this filter." />
        </Card>
      ) : (
        owners.map((owner) => {
          const busy = busyId === owner.id;
          const noDocs = owner.documents.length === 0;

          return (
            <Card
              key={owner.id}
              title={owner.businessName}
              actions={
                <Badge
                  tone={
                    owner.verificationStatus === 'APPROVED'
                      ? 'success'
                      : owner.verificationStatus === 'REJECTED'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {owner.verificationStatus}
                </Badge>
              }
            >
              <div className="grid-2">
                <div className="stack">
                  <Line label="Owner" value={owner.legalName} />
                  <Line label="Phone" value={`+91 ${owner.contactPhone}`} />
                  {owner.contactEmail ? <Line label="Email" value={owner.contactEmail} /> : null}
                  <Line label="PAN" value={owner.panLast4 ? `•••• ${owner.panLast4}` : 'Not provided'} />
                  <Line label="GSTIN" value={owner.gstin ?? 'Not provided'} />
                </div>
                <div className="stack">
                  <Line label="Bank account" value={owner.bankAccountName ?? 'Not provided'} />
                  <Line label="IFSC" value={owner.bankIfsc ?? 'Not provided'} />
                  <Line label="UPI" value={owner.upiId ?? 'Not provided'} />
                  <Line label="Applied" value={formatDate(owner.createdAt)} />
                  <Line label="Properties" value={String(owner._count.hostels)} />
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  Documents ({owner.documents.length})
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {noDocs ? (
                    <Badge tone="danger">None uploaded</Badge>
                  ) : (
                    owner.documents.map((doc) => (
                      <a key={doc.id} href={doc.url} target="_blank" rel="noreferrer">
                        <Badge
                          tone={
                            doc.status === 'APPROVED'
                              ? 'success'
                              : doc.status === 'REJECTED'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {doc.type.replace(/_/g, ' ').toLowerCase()} · {doc.status}
                        </Badge>
                      </a>
                    ))
                  )}
                </div>
                {owner.rejectionReason ? (
                  <div className="alert error" style={{ marginTop: 10, marginBottom: 0 }}>
                    Rejected: {owner.rejectionReason}
                  </div>
                ) : null}
              </div>

              <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
                {owner.verificationStatus !== 'APPROVED' ? (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy || noDocs}
                    title={noDocs ? 'This owner has uploaded no documents' : undefined}
                    onClick={() => void act(owner.id, 'APPROVED')}
                  >
                    Approve
                  </button>
                ) : null}

                {owner.verificationStatus !== 'REJECTED' ? (
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => setRejecting(owner)}
                  >
                    Reject
                  </button>
                ) : null}

                {owner.verificationStatus === 'APPROVED' ? (
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={busy}
                    onClick={() => void act(owner.id, 'SUSPENDED')}
                  >
                    Suspend
                  </button>
                ) : null}

                <button className="btn btn-ghost btn-sm" onClick={() => void showSettlement(owner)}>
                  Settlement
                </button>
              </div>
            </Card>
          );
        })
      )}

      <ReasonDialog
        open={rejecting !== null}
        title={`Reject ${rejecting?.businessName ?? ''}?`}
        label="Reason shown to the owner"
        confirmLabel="Reject owner"
        onCancel={() => setRejecting(null)}
        onSubmit={(reason) => {
          const owner = rejecting;
          setRejecting(null);
          if (owner) void act(owner.id, 'REJECTED', reason);
        }}
      />

      {settlement ? (
        <div className="overlay" onClick={() => setSettlement(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="row-between">
              <div>
                <h2 className="drawer-title">Settlement · {settlement.owner.businessName}</h2>
                <p className="small muted mb-0">
                  Commission override:{' '}
                  {settlement.owner.commissionOverrideBps != null
                    ? `${settlement.owner.commissionOverrideBps / 100}%`
                    : 'platform default'}
                </p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSettlement(null)}>
                Close
              </button>
            </div>

            {settlement.rows.length === 0 ? (
              <Empty title="No settled bookings" message="This owner has no confirmed bookings yet." />
            ) : (
              <table className="table" style={{ marginTop: 14 }}>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Date</th>
                    <th className="num">Gross</th>
                    <th className="num">Rate</th>
                    <th className="num">Commission</th>
                    <th className="num">Payout</th>
                    <th className="num">Deposit held</th>
                  </tr>
                </thead>
                <tbody>
                  {settlement.rows.map((r) => (
                    <tr key={r.bookingRef}>
                      <td className="mono">{r.bookingRef}</td>
                      <td className="small">{formatDate(r.createdAt)}</td>
                      <td className="num">{formatRupees(r.baseRent + r.foodCharges)}</td>
                      <td className="num">{(r.commissionRateBps / 100).toFixed(1)}%</td>
                      <td className="num" style={{ color: 'var(--danger)' }}>
                        −{formatRupees(r.commissionAmount)}
                      </td>
                      <td className="num" style={{ fontWeight: 600, color: 'var(--success)' }}>
                        {formatRupees(r.ownerPayout)}
                      </td>
                      <td className="num muted">{formatRupees(r.depositAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small">
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}