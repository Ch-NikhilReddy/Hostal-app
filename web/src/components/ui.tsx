import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { formatDateTime } from '../api/client';

/**
 * Shared presentational components.
 *
 * Status colours are defined once and keyed by the API's enum value, so a booking
 * status cannot render green on one screen and amber on another — a bug that is
 * easy to introduce and hard to spot in review.
 */

export const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'> = {
  PENDING_PAYMENT: 'warning',
  PENDING_OWNER: 'warning',
  CONFIRMED: 'success',
  CHECKED_IN: 'info',
  CHECKED_OUT: 'neutral',
  CANCELLED_BY_STUDENT: 'danger',
  CANCELLED_BY_OWNER: 'danger',
  REJECTED: 'danger',
  REFUNDED: 'neutral',
  EXPIRED: 'neutral',
  PENDING: 'warning',
  APPROVED: 'success',
  DRAFT: 'neutral',
  SUSPENDED: 'danger',
};

export const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PENDING_OWNER: 'Awaiting hostel',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  CHECKED_OUT: 'Completed',
  CANCELLED_BY_STUDENT: 'Cancelled by student',
  CANCELLED_BY_OWNER: 'Cancelled by owner',
  REJECTED: 'Declined',
  REFUNDED: 'Refunded',
  EXPIRED: 'Expired',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof STATUS_TONE }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      {STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="card-head">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <div className="small muted" style={{ marginTop: 10 }}>
        {label}
      </div>
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error">
      <div className="row-between">
        <span>{error}</span>
        {onRetry ? (
          <button className="btn btn-outline btn-sm" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ icon = '📭', title, message }: { icon?: string; title: string; message: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="small">{message}</div>
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {error ? <div className="field-error">{error}</div> : null}
      {!error && hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Confirm dialog in place of window.confirm.
 *
 * The native confirm is blocked in some embedded contexts and cannot express a
 * destructive action with the same weight as the rest of the UI.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="drawer" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="drawer-title">{title}</h2>
        <p className="muted small">{message}</p>
        <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn btn-${tone}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Text input that reports the API's field-level validation error inline. */
export function ReasonDialog({
  open,
  title,
  label,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  if (!open) return null;
  const tooShort = reason.trim().length < 3;

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="drawer" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="drawer-title">{title}</h2>
        <div style={{ marginTop: 14 }}>
          <Field
            label={label}
            error={touched && tooShort ? 'Please give at least 3 characters so the owner knows what to fix.' : null}
            hint="The owner sees this message verbatim."
          >
            <textarea
              className={`input${touched && tooShort ? ' has-error' : ''}`}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Bank proof is unreadable, please re-upload a clearer photo."
            />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setTouched(true);
              if (!tooShort) onSubmit(reason.trim());
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function relativeTime(iso: string): string {
  return formatDateTime(iso);
}