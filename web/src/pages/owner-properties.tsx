import { useEffect, useState } from 'react';
import { formatRupees } from '../api/client';
import {
  getOwnerVerification,
  listOwnerHostels,
  publishHostel,
  type Hostel,
} from '../api/endpoints';
import { Badge, Card, Empty, ErrorAlert, Loading, ReasonDialog } from '../components/ui';
import type { VerificationStatus } from '../api/endpoints';

const DOC_TYPES = [
  { key: 'PAN_CARD', label: 'PAN card' },
  { key: 'BANK_PROOF', label: 'Bank proof' },
  { key: 'GST_CERTIFICATE', label: 'GST certificate' },
  { key: 'PROPERTY_PROOF', label: 'Property ownership proof' },
] as const;

export function OwnerProperties() {
  const [hostels, setHostels] = useState<Hostel[]>([]);
  const [verification, setVerification] = useState<Awaited<ReturnType<typeof getOwnerVerification>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejection, setRejection] = useState<{ status: VerificationStatus; reason: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [h, v] = await Promise.all([listOwnerHostels(), getOwnerVerification()]);
      setHostels(h.hostels);
      setVerification(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load properties.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function togglePublish(hostel: Hostel) {
    setBusyId(hostel.id);
    setError(null);
    try {
      await publishHostel(hostel.id, !hostel.published);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the listing.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Loading label="Loading your properties…" />;
  if (error && !verification) return <ErrorAlert error={error} onRetry={() => void load()} />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Properties</h1>
          <p className="page-sub">Your listings, their review status and whether students can see them.</p>
        </div>
      </div>

      {error ? <ErrorAlert error={error} /> : null}

      {/* Verification panel */}
      {verification ? (
        <Card
          title="Verification"
          actions={
            <Badge
              tone={
                verification.verificationStatus === 'APPROVED'
                  ? 'success'
                  : verification.verificationStatus === 'REJECTED'
                    ? 'danger'
                    : 'warning'
              }
            >
              {verification.verificationStatus}
            </Badge>
          }
        >
          {verification.verificationStatus !== 'APPROVED' ? (
            <div className={`alert ${verification.verificationStatus === 'REJECTED' ? 'error' : 'warning'}`}>
              {verification.verificationStatus === 'REJECTED'
                ? `Rejected: ${verification.rejectionReason ?? 'no reason given'}`
                : 'Upload the documents below. An admin reviews them before your listings go live.'}
            </div>
          ) : (
            <div className="alert success">Verified. You can publish properties and receive bookings.</div>
          )}

          <div className="grid-2">
            {DOC_TYPES.map((doc) => {
              const uploaded = verification.documents.filter((d) => d.type === doc.key);
              const approved = uploaded.some((d) => d.status === 'APPROVED');
              return (
                <div key={doc.key} className="row-between" style={{ padding: '8px 0' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{doc.label}</div>
                    <div className="small muted">
                      {approved
                        ? 'Verified'
                        : uploaded.length > 0
                          ? 'Uploaded — under review'
                          : 'Not uploaded'}
                    </div>
                  </div>
                  <Badge tone={approved ? 'success' : uploaded.length > 0 ? 'warning' : 'danger'}>
                    {approved ? '✓' : uploaded.length > 0 ? '⏳' : '✕'}
                  </Badge>
                </div>
              );
            })}
          </div>

          <div className="field-hint" style={{ marginTop: 10 }}>
            Document upload is not wired to S3 in this MVP. For local testing, POST a document directly:
            {' '}
            <span className="mono">POST /v1/owner/documents</span> with{' '}
            <span className="mono">{'{ type, url }'}</span>.
          </div>
        </Card>
      ) : null}

      <Card title={`${hostels.length} propert${hostels.length === 1 ? 'y' : 'ies'}`}>
        {hostels.length === 0 ? (
          <Empty icon="🏢" title="No properties yet" message="Add your first property to start receiving bookings." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Area</th>
                <th>Room types</th>
                <th>From</th>
                <th className="num">Bookings</th>
                <th>Review</th>
                <th>Visibility</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hostels.map((h) => {
                const cheapest = [...h.roomTypes].sort((a, b) => a.monthlyRent - b.monthlyRent)[0];
                const beds = h.roomTypes.reduce((sum, rt) => sum + rt._count.beds, 0);
                const canPublish = verification?.canPublish ?? false;

                return (
                  <tr key={h.id}>
                    <td>
                      <strong>{h.name}</strong>
                      <div className="small muted mono">{h.slug}</div>
                    </td>
                    <td>
                      {h.area}, {h.city}
                    </td>
                    <td>
                      {h.roomTypes.length}
                      <div className="small muted">{beds} beds</div>
                    </td>
                    <td>{cheapest ? formatRupees(cheapest.monthlyRent) : '—'}</td>
                    <td className="num">{h._count.bookings}</td>
                    <td>
                      <Badge tone={h.verificationStatus === 'APPROVED' ? 'success' : 'warning'}>
                        {h.verificationStatus}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={h.published ? 'brand' : 'neutral'}>{h.published ? 'Live' : 'Hidden'}</Badge>
                    </td>
                    <td className="right">
                      {!canPublish ? (
                        <span className="small muted" title="Complete verification to publish">
                          🔒 Locked
                        </span>
                      ) : (
                        <button
                          className="btn btn-outline btn-sm"
                          disabled={busyId === h.id}
                          onClick={() => void togglePublish(h)}
                        >
                          {h.published ? 'Unpublish' : 'Publish'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <ReasonDialog
        open={rejection !== null}
        title="Send a reason"
        label="Reason"
        confirmLabel="Send"
        onCancel={() => setRejection(null)}
        onSubmit={(reason) => {
          setRejection(null);
          void reason;
        }}
      />
    </>
  );
}