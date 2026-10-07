import { useState } from 'react';
import { requestOtp, verifyOtp, type User } from '../api/endpoints';
import { setTokens } from '../api/client';
import { Field } from '../components/ui';

export function LoginPage({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const digits = phone.replace(/\D/g, '').slice(-10);
  const phoneValid = /^[6-9]\d{9}$/.test(digits);

  async function send() {
    setError(null);
    if (!phoneValid) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    setBusy(true);
    try {
      const res = await requestOtp(digits);
      setDevOtp(res.devOtp ?? null);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    if (code.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    try {
      const res = await verifyOtp({
        phone: digits,
        code,
        // Every account created here is an owner. Admin accounts are provisioned
        // directly in the database and cannot self-register — see auth.routes.ts.
        name: name || undefined,
        registerRole: 'OWNER',
      });
      setTokens(res.accessToken, res.refreshToken);
      onSignedIn(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 20 }}>
          <div className="brand-mark">HM</div>
          <div>
            <div className="brand-name">HostelMitra</div>
            <div className="brand-sub">Owner dashboard & admin panel</div>
          </div>
        </div>

        {error ? <div className="alert error">{error}</div> : null}

        {step === 'phone' ? (
          <>
            <Field label="Mobile number" hint="We will send a one-time code. No password needed.">
              <input
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                inputMode="numeric"
                autoFocus
              />
            </Field>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => void send()} disabled={busy || !phoneValid}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            {devOtp ? (
              <div className="alert warning">
                <strong>Development mode.</strong> No SMS provider is configured, so your code is{' '}
                <span className="mono">{devOtp}</span>.{' '}
                <button className="btn btn-outline btn-sm" onClick={() => setCode(devOtp)}>
                  Fill it in
                </button>
              </div>
            ) : null}

            <Field label={`Code sent to +91 ${digits}`}>
              <input
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                autoFocus
              />
            </Field>

            <Field label="Your name" hint="Required only if this is your first sign-in.">
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ravi Kumar"
              />
            </Field>

            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => void verify()} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>

            <button
              className="btn btn-ghost"
              style={{ width: '100%', marginTop: 8 }}
              onClick={() => {
                setStep('phone');
                setCode('');
                setDevOtp(null);
              }}
            >
              Change number
            </button>
          </>
        )}
      </div>
    </div>
  );
}