import { useCallback, useEffect, useState } from 'react';
import { getSession, logout, useLiveState, useNow } from './api';
import { Controls } from './components/Controls';
import { FlightStatus } from './components/FlightStatus';
import { Header } from './components/Header';
import { Spinner } from './components/Icons';
import { Login } from './components/Login';
import { WebFmcPanel } from './components/WebFmcPanel';
import { deriveLinkStatus } from './status';

type Auth = 'checking' | 'signed_in' | 'signed_out' | 'offline';

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');

  const checkSession = useCallback(() => {
    getSession()
      .then((s) => setAuth(s.authenticated ? 'signed_in' : 'signed_out'))
      .catch(() => setAuth('offline'));
  }, []);

  useEffect(checkSession, [checkSession]);

  const onUnauthorized = useCallback(() => setAuth('signed_out'), []);

  if (auth === 'checking') {
    return (
      <main className="splash">
        <Spinner className="splash-spin" />
        <span>Connecting…</span>
      </main>
    );
  }
  if (auth === 'offline') {
    return (
      <main className="splash">
        <p className="feedback tone-bad">Cannot reach X-Plane Remote on your PC.</p>
        <p className="hint">Check that the app is running on the PC and that Tailscale is connected on this phone.</p>
        <button type="button" className="btn" onClick={() => { setAuth('checking'); checkSession(); }}>
          Try again
        </button>
      </main>
    );
  }
  if (auth === 'signed_out') return <Login onSignedIn={() => setAuth('signed_in')} />;
  return <Dashboard onUnauthorized={onUnauthorized} />;
}

function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, stream, receivedAt } = useLiveState(true, onUnauthorized);
  const now = useNow(1000);
  const link = deriveLinkStatus(state, stream, receivedAt, now);
  const paused = link.live ? (state?.telemetry.paused ?? null) : null;
  const ageMs =
    state?.telemetry.ageMs != null && receivedAt !== null ? state.telemetry.ageMs + Math.max(0, now - receivedAt) : null;

  const signOut = async () => {
    await logout().catch(() => {});
    onUnauthorized();
  };

  return (
    <div className="app">
      {state?.source === 'mock' && (
        <div className="mock-banner" role="alert">
          MOCK DATA — development simulator. Nothing here is live X-Plane data.
        </div>
      )}
      <Header link={link} paused={paused} onSignOut={signOut} />
      {!link.live && state && (
        <div className={`banner tone-${link.tone}`} role="status">
          {link.detail}
        </div>
      )}
      <main className="layout">
        <div className="col-main">
          <Controls state={state} live={link.live} onUnauthorized={onUnauthorized} />
          <FlightStatus state={state} live={link.live} ageMs={ageMs} />
        </div>
        <div className="col-side">
          <WebFmcPanel onUnauthorized={onUnauthorized} />
        </div>
      </main>
      <footer className="foot">
        Private to your tailnet · actions are confirmed by X-Plane before they are reported
      </footer>
    </div>
  );
}
