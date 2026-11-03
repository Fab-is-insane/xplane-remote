// Thin client for the X-Plane Remote server API plus the live-state hook.

import { useEffect, useRef, useState } from 'react';
import type { CduMirror, CduScreen, PauseAction, PauseResponse, PublicState, SessionInfo, WebFmcStatus } from '../../server/src/shared/api-types';

export type { CduMirror, CduScreen, PauseAction, PauseResponse, PublicState, SessionInfo, WebFmcStatus };

export class UnauthorizedError extends Error {}

// Every mutating request carries this header; the server rejects any POST /
// DELETE without it (a cross-site form or image request cannot add it).
const MUTATING_HEADERS = { 'Content-Type': 'application/json', 'X-XPR-Request': '1' };

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Unexpected response from server (HTTP ${res.status})`);
  }
}

export async function getSession(): Promise<SessionInfo> {
  const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  return readJson<SessionInfo>(res);
}

export async function login(password: string): Promise<SessionInfo> {
  const res = await fetch('/api/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: MUTATING_HEADERS,
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await readJson<{ message?: string }>(res).catch(() => ({ message: undefined }));
    throw new Error(body.message ?? `Sign-in failed (HTTP ${res.status})`);
  }
  return readJson<SessionInfo>(res);
}

export async function logout(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin', headers: MUTATING_HEADERS, body: '{}' });
}

/** Ask the server to pause/resume. The response reflects what X-Plane actually reported. */
export async function requestPause(action: PauseAction): Promise<PauseResponse> {
  const res = await fetch(`/api/sim/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: MUTATING_HEADERS,
    body: '{}',
  });
  if (res.status === 401) throw new UnauthorizedError('Signed out');
  if (res.status === 429) {
    const body = await readJson<{ message?: string }>(res).catch(() => ({ message: undefined }));
    return { ok: false, action, error: 'busy', message: body.message ?? 'Too many requests.', paused: null };
  }
  const body = await readJson<Partial<PauseResponse> & { message?: string }>(res);
  if (typeof body.ok !== 'boolean') throw new Error(body.message ?? `Server returned HTTP ${res.status}`);
  return body as PauseResponse;
}

export async function getWebFmcStatus(): Promise<WebFmcStatus> {
  const res = await fetch('/api/webfmc/status', { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) throw new UnauthorizedError('Signed out');
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  return readJson<WebFmcStatus>(res);
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting';

export interface LiveState {
  state: PublicState | null;
  stream: StreamStatus;
  /** Client clock (ms) when the last state message arrived. */
  receivedAt: number | null;
  /** FF777 CDU screens (separate `cdu` event, sent only when a screen changes). */
  cdu: CduMirror | null;
}

/**
 * Subscribe to /api/stream (Server-Sent Events). The browser reconnects on
 * its own; if the stream is closed for good we check whether the session
 * expired and otherwise retry.
 */
export function useLiveState(enabled: boolean, onUnauthorized: () => void): LiveState {
  const [live, setLive] = useState<LiveState>({ state: null, stream: 'connecting', receivedAt: null, cdu: null });
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const open = () => {
      if (disposed) return;
      es = new EventSource('/api/stream');
      es.addEventListener('state', (e) => {
        try {
          const state = JSON.parse((e as MessageEvent<string>).data) as PublicState;
          setLive((l) => ({ ...l, state, stream: 'open', receivedAt: Date.now() }));
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener('cdu', (e) => {
        try {
          const msg = JSON.parse((e as MessageEvent<string>).data) as CduMirror | null;
          setLive((l) => {
            if (!msg) return { ...l, cdu: null };
            if (!msg.partial || !l.cdu) return { ...l, cdu: msg };
            // Partial update: replace only the screens that changed.
            const bySide = new Map(l.cdu.screens.map((s) => [s.side, s]));
            for (const s of msg.screens) bySide.set(s.side, s);
            return { ...l, cdu: { ...l.cdu, screens: [...bySide.values()].sort((a, b) => 'LCR'.indexOf(a.side) - 'LCR'.indexOf(b.side)) } };
          });
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener('auth', () => {
        es?.close();
        unauthorizedRef.current();
      });
      es.onerror = () => {
        setLive((l) => ({ ...l, stream: 'reconnecting' }));
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          getSession()
            .then((s) => {
              if (!s.authenticated) unauthorizedRef.current();
              else retry = setTimeout(open, 3000);
            })
            .catch(() => {
              retry = setTimeout(open, 3000);
            });
        }
      };
    };

    // Phones suspend background tabs; reconnect promptly when shown again.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    open();
    return () => {
      disposed = true;
      clearTimeout(retry);
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return live;
}

/** Re-render every `ms` so relative times ("2 s ago") stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
