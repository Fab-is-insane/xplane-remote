import { useCallback, useEffect, useState } from 'react';
import { getSession, logout, useLiveState, useNow } from './api';
import { Controls } from './components/Controls';
import { FlightStatus } from './components/FlightStatus';
import { Header } from './components/Header';
import { Login } from './components/Login';
import { WebFmcPanel } from './components/WebFmcPanel';
import { CduMirror } from './components/CduMirror';
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
        <span className="cursor">&gt; establishing uplink</span>
      </main>
    );
  }
  if (auth === 'offline') {
    return (
      <main className="splash">
        <p className="feedback tone-bad">host unreachable // X-Plane Remote is not answering</p>
        <p className="hint">is the app running on the PC, and is Tailscale on for this phone?</p>
        <button type="button" className="btn" onClick={() => { setAuth('checking'); checkSession(); }}>
          retry
        </button>
      </main>
    );
  }
  if (auth === 'signed_out') return <Login onSignedIn={() => setAuth('signed_in')} />;
  return <Dashboard onUnauthorized={onUnauthorized} />;
}

function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, stream, receivedAt, cdu } = useLiveState(true, onUnauthorized);
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
          !! SIMULATED FEED — MOCK DATA, NOT LIVE X-PLANE !!
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
          {/* WebFMC (free) supports neither the FF777 nor the ToLiss, so show the CDU mirror instead. */}
          {state?.profile === 'ff777' || state?.profile === 'toliss' ? (
            <CduMirror data={cdu} profile={state.profile} />
          ) : (
            <WebFmcPanel onUnauthorized={onUnauthorized} />
          )}
        </div>
      </main>
      <footer className="foot">
        tailnet only // every action verified against sim/time/paused // leave no trace
      </footer>
    </div>
  );
}
