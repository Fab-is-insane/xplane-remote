// Derives the single "how trustworthy is what I'm seeing" status shown in the header.

import type { PublicState, StreamStatus } from './api';

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export interface LinkStatus {
  label: string;
  tone: Tone;
  detail: string;
  /** True only when values on screen are live, fresh X-Plane data. */
  live: boolean;
}

/** If no message arrived from our own server for this long, treat it as unreachable. */
const SERVER_SILENCE_MS = 5000;

export function deriveLinkStatus(
  state: PublicState | null,
  stream: StreamStatus,
  receivedAt: number | null,
  now: number,
): LinkStatus {
  // The server pushes at least once per second; silence means the stream is broken
  // even if the browser has not noticed yet.
  const serverSilent = receivedAt === null || now - receivedAt > SERVER_SILENCE_MS || (stream !== 'open' && now - receivedAt > 2000);
  if (!state || serverSilent) {
    return {
      label: state ? 'Host down' : 'Handshake',
      tone: state ? 'bad' : 'muted',
      detail: state
        ? 'Lost contact with X-Plane Remote on your PC (PC asleep, app stopped, or Tailscale disconnected). Values below are not live.'
        : 'Contacting X-Plane Remote…',
      live: false,
    };
  }
  switch (state.link) {
    case 'disconnected':
      return { label: 'Sim down', tone: 'bad', detail: state.linkDetail ?? 'X-Plane is not reachable.', live: false };
    case 'connecting':
      return { label: 'Handshake', tone: 'warn', detail: state.linkDetail ?? 'Connecting to X-Plane…', live: false };
    case 'no_flight':
      return { label: 'No flight', tone: 'warn', detail: state.linkDetail ?? 'X-Plane is running but no flight is loaded.', live: false };
    case 'connected':
      if (!state.telemetry.fresh) {
        return {
          label: 'Stale',
          tone: 'warn',
          detail: 'X-Plane has stopped answering. Values below are the last ones received.',
          live: false,
        };
      }
      return { label: state.source === 'mock' ? 'Mock' : 'Live', tone: state.source === 'mock' ? 'warn' : 'good', detail: 'Receiving live telemetry from X-Plane.', live: true };
  }
}
