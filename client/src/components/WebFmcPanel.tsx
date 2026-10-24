import { useCallback, useEffect, useId, useState } from 'react';
import { UnauthorizedError, getWebFmcStatus, type WebFmcStatus } from '../api';
import { ExternalIcon, RefreshIcon, Spinner } from './Icons';

const OPEN_KEY = 'xpr.webfmc.open';

// Default: open on wide screens, collapsed on phones (the CDU is tall).
function readOpen(): boolean {
  const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches;
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === null ? wide : v === '1';
  } catch {
    return wide;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable (private mode) — not important */
  }
}

export function WebFmcPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<WebFmcStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(readOpen);
  const [frameKey, setFrameKey] = useState(0);
  const bodyId = useId();

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getWebFmcStatus());
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized();
      setError('Could not ask the server about WebFMC.');
    } finally {
      setChecking(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void check();
  }, [check]);

  // Poll while WebFMC is not usable, so it appears once X-Plane has started.
  useEffect(() => {
    if (status?.embeddable || status?.enabled === false) return;
    const t = setInterval(() => void check(), 15_000);
    return () => clearInterval(t);
  }, [status?.embeddable, status?.enabled, check]);

  const toggle = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };

  const usable = Boolean(status?.reachable && status.embeddable);

  return (
    <section className={`card webfmc${open ? ' is-open' : ''}`} aria-labelledby="webfmc-title">
      <div className="card-head">
        <button type="button" className="collapse-btn" onClick={toggle} aria-expanded={open} aria-controls={bodyId}>
          <h2 id="webfmc-title" className="card-title">
            WebFMC
          </h2>
          <span className="collapse-state" aria-hidden="true">
            {open ? '[-]' : '[+]'}
          </span>
        </button>
        <div className="card-actions">
          {usable && (
            <>
              <button type="button" className="icon-btn" onClick={() => setFrameKey((k) => k + 1)} aria-label="Reload WebFMC" title="Reload">
                <RefreshIcon className="icon" />
              </button>
              <a className="icon-btn" href={status!.proxyPath} target="_blank" rel="noopener" aria-label="Open WebFMC full screen" title="Open full screen">
                <ExternalIcon className="icon" />
              </a>
            </>
          )}
        </div>
      </div>

      <div id={bodyId} className="webfmc-body" hidden={!open}>
        {usable && open ? (
          <div className="fmc-frame-wrap">
            <iframe
              key={frameKey}
              className="fmc-frame"
              src={status!.proxyPath}
              title="WebFMC — Zibo 737 CDU"
              referrerPolicy="no-referrer"
              allow="fullscreen"
            />
          </div>
        ) : (
          <div className="fmc-fallback">
            {!status && !error ? (
              <p className="feedback tone-muted">
                <span className="cursor">probing webfmc on :9090</span>
              </p>
            ) : (
              <>
                <p className="feedback tone-muted">{error ?? status?.reason ?? 'WebFMC is not available.'}</p>
                <div className="btn-row">
                  <button type="button" className="btn" onClick={() => void check()} disabled={checking}>
                    {checking ? <Spinner className="inline-spin" /> : <RefreshIcon className="icon" />}
                    retry
                  </button>
                  {status?.reachable && (
                    <a className="btn" href={status.proxyPath} target="_blank" rel="noopener">
                      <ExternalIcon className="icon" /> open via app
                    </a>
                  )}
                  {status?.directUrl && (
                    <a className="btn" href={status.directUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalIcon className="icon" /> open direct
                    </a>
                  )}
                </div>
                {!status?.directUrl && status?.reachable === false && status.enabled && (
                  <p className="hint">set WEBFMC_DIRECT_URL in .env to show a direct link here as a fallback</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
