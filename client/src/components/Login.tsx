import { useState, type FormEvent } from 'react';
import { login } from '../api';
import { LogoMark, Spinner } from './Icons';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit} noValidate>
        <LogoMark className="login-mark" />
        <h1 className="login-title">X-Plane Remote</h1>
        <p className="login-sub">Sign in to monitor and control your simulator.</p>

        <label className="field-label" htmlFor="password">
          Password
        </label>
        <div className="field">
          <input
            id="password"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'login-error' : 'login-hint'}
            required
            autoFocus
          />
          <button type="button" className="field-toggle" onClick={() => setShow((s) => !s)} aria-pressed={show}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        {error ? (
          <p id="login-error" className="feedback tone-bad" role="alert">
            {error}
          </p>
        ) : (
          <p id="login-hint" className="hint">
            The password is APP_PASSWORD in the .env file on your PC.
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={!password || busy}>
          {busy && <Spinner className="inline-spin" />} Sign in
        </button>
      </form>
    </main>
  );
}
