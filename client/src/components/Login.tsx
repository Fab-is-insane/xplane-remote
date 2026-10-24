import { useState, type FormEvent } from 'react';
import { login } from '../api';
import { Spinner } from './Icons';

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
        <div className="term-bar" aria-hidden="true">
          <span>xpr@host:~$ ./auth</span>
          <span>tty0</span>
        </div>
        <div className="term-body">
          <h1 className="login-title">X-PLANE REMOTE</h1>
          <p className="term-line">
            <span className="prompt">&gt;</span> <span className="cursor">authenticate to continue</span>
          </p>

          <label className="field-label" htmlFor="password">
            PIN
          </label>
          <div className="field">
            <span className="field-prompt" aria-hidden="true">
              &gt;
            </span>
            <input
              id="password"
              name="password"
              type={show ? 'text' : 'password'}
              inputMode="numeric"
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
              {show ? 'hide' : 'show'}
            </button>
          </div>
          {error ? (
            <p id="login-error" className="feedback tone-bad" role="alert" style={{ marginTop: 10 }}>
              access denied // {error}
            </p>
          ) : (
            <p id="login-hint" className="hint">
              PIN = APP_PASSWORD in .env on the host
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={!password || busy}>
            {busy && <Spinner className="inline-spin" />} {busy ? 'VERIFYING' : 'ENTER'}
          </button>
        </div>
      </form>
    </main>
  );
}
