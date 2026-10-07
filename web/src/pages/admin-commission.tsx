import { useEffect, useState } from 'react';
import { formatDate } from '../api/client';
import {
  getCommission,
  listOwners,
  setCommission,
  setOwnerCommissionOverride,
  type Owner,
} from '../api/endpoints';
import { Badge, Card, ErrorAlert, Field, Loading, Stat } from '../components/ui';

/**
 * Commission management.
 *
 * Two levers, and the distinction is the important part:
 *   - the PLATFORM RATE applies to every owner from a given date forward;
 *   - a per-OWNER OVERRIDE takes precedence for that owner.
 *
 * Neither rewrites history: every booking stores the rate that produced its
 * commission, so a rate change only affects bookings made afterwards.
 */
export function AdminCommission() {
  const [active, setActive] = useState<{ id: string; percentageBps: number; label: string; effectiveFrom: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; percentageBps: number; label: string; effectiveFrom: string; effectiveTo: string | null }[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [comm, own] = await Promise.all([getCommission(), listOwners({})]);
      setActive(comm.active);
      setHistory(comm.history);
      setOwners(own.owners);
      if (comm.active) {
        setPercent(String(comm.active.percentageBps / 100));
        setLabel(`${comm.active.label.split(' — ')[0]} — ${comm.active.percentageBps / 100}%`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load commission settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 50) {
      setError('Enter a percentage between 0 and 50.');
      return;
    }
    if (label.trim().length < 2) {
      setError('Give this rate a label so it is identifiable in the history.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await setCommission(value, label.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the rate.');
    } finally {
      setSaving(false);
    }
  }

  async function setOverride(ownerId: string, bps: number | null) {
    setBusyOwner(ownerId);
    setError(null);
    try {
      await setOwnerCommissionOverride(ownerId, bps);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the override.');
    } finally {
      setBusyOwner(null);
    }
  }

  if (loading) return <Loading label="Loading commission settings…" />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Commission</h1>
          <p className="page-sub">
            Rates are snapshotted onto each booking when it is created. Changing a rate never rewrites
            bookings already settled.
          </p>
        </div>
      </div>

      {error ? <ErrorAlert error={error} onRetry={() => void load()} /> : null}

      <div className="stat-grid">
        <Stat
          label="Current platform rate"
          value={active ? `${active.percentageBps / 100}%` : '—'}
          tone="brand"
          hint={active?.label}
        />
        <Stat
          label="Effective since"
          value={active ? formatDate(active.effectiveFrom) : '—'}
          hint="Applies to new bookings only"
        />
        <Stat
          label="Owners with a custom rate"
          value={owners.filter((o) => o.commissionOverrideBps != null).length}
          hint={`of ${owners.length} owners`}
        />
      </div>

      <Card title="Set a new platform rate">
        <div className="grid-2">
          <Field
            label="Commission percentage"
            hint="Applied to rent plus food. Deposits are never charged commission."
          >
            <input
              className="input"
              type="number"
              min="0"
              max="50"
              step="0.5"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </Field>
          <Field label="Label" hint="Shown in the history below so rates are traceable.">
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Default 2027 — 12%"
            />
          </Field>
        </div>

        <div className="alert info">
          The current rate will be closed off and this one becomes active immediately. Bookings already
          settled keep the rate they were created with.
        </div>

        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Apply rate'}
        </button>
      </Card>

      <Card title={`Rate history (${history.length})`}>
        <table className="table">
          <thead>
            <tr>
              <th>Rate</th>
              <th>Label</th>
              <th>From</th>
              <th>To</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => {
              const isActive = h.effectiveTo === null;
              return (
                <tr key={h.id}>
                  <td style={{ fontWeight: 700 }}>{h.percentageBps / 100}%</td>
                  <td>{h.label}</td>
                  <td className="small">{formatDate(h.effectiveFrom)}</td>
                  <td className="small">{h.effectiveTo ? formatDate(h.effectiveTo) : '—'}</td>
                  <td>
                    <Badge tone={isActive ? 'success' : 'neutral'}>{isActive ? 'Active' : 'Superseded'}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Per-owner overrides">
        <p className="small muted" style={{ marginTop: 0 }}>
          An override takes precedence over the platform rate for that owner only. Leave blank to use the
          platform rate.
        </p>

        <table className="table">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Status</th>
              <th>Rate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {owners.map((o) => (
              <OwnerRow
                key={o.id}
                owner={o}
                busy={busyOwner === o.id}
                onChange={(bps) => void setOverride(o.id, bps)}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function OwnerRow({
  owner,
  busy,
  onChange,
}: {
  owner: Owner;
  busy: boolean;
  onChange: (bps: number | null) => void;
}) {
  const [value, setValue] = useState(
    owner.commissionOverrideBps != null ? String(owner.commissionOverrideBps / 100) : '',
  );

  return (
    <tr>
      <td>
        <strong>{owner.businessName}</strong>
        <div className="small muted">{owner.legalName}</div>
      </td>
      <td>
        <Badge tone={owner.verificationStatus === 'APPROVED' ? 'success' : 'warning'}>
          {owner.verificationStatus}
        </Badge>
      </td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input"
            style={{ width: 82 }}
            type="number"
            min="0"
            max="50"
            step="0.5"
            placeholder="default"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="small muted">%</span>
        </div>
      </td>
      <td className="right">
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button
            className="btn btn-outline btn-sm"
            disabled={busy || value === '' || Number.isNaN(Number(value))}
            onClick={() => onChange(Math.round(Number(value) * 100))}
          >
            Save
          </button>
          {owner.commissionOverrideBps != null ? (
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                setValue('');
                onChange(null);
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}