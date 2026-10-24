// Turns raw simulator values into the PublicState the client renders.
// Unit conversion and the Zibo T/D interpretation live here so they are
// covered by unit tests.

import type { ControlInfo, PublicState, Telemetry, TodInfo } from './shared/api-types.js';
import { FT_PER_M, KT_PER_MS } from './xplane/datarefs.js';
import type { PauseCapability, SimStatus } from './xplane/simSource.js';

const TD_SOURCE = 'laminar/B738/fms/vnav_td_dist';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const round = (v: number | null, digits = 0): number | null => {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function buildTelemetry(status: SimStatus, now: number, staleMs: number): Telemetry {
  const v = status.values;
  const lastUpdate = status.lastContactAt;
  const ageMs = lastUpdate === null ? null : Math.max(0, now - lastUpdate);
  const fresh = status.link === 'connected' && ageMs !== null && ageMs <= staleMs;

  const paused = num(v.paused);
  const gsMs = num(v.groundspeedMs);
  const elevM = num(v.elevationM);
  const hdg = num(v.headingMag);

  return {
    fresh,
    lastUpdate,
    ageMs,
    paused: paused === null ? null : paused !== 0,
    altitudeFt: round(num(v.altitudeFt)),
    trueAltitudeFt: round(elevM === null ? null : elevM * FT_PER_M),
    groundspeedKt: round(gsMs === null ? null : gsMs * KT_PER_MS, 1),
    iasKt: round(num(v.iasKt), 1),
    headingMagDeg: round(hdg === null ? null : ((hdg % 360) + 360) % 360, 1),
    verticalSpeedFpm: round(num(v.vsFpm)),
    latitude: round(num(v.latitude), 5),
    longitude: round(num(v.longitude), 5),
    aircraftName: str(v.acfName),
    aircraftIcao: str(v.acfIcao),
  };
}

/**
 * Zibo 737 T/D, derived from the aircraft's own FMC datarefs (B738.a_fms.lua):
 *  - vnav_td_idx == 0            → no T/D computed (no route/CRZ ALT/PERF INIT)
 *  - vnav_td_dist >= 9999        → FMC still recalculating the path
 *  - flight_phase >= 5 (not 8)   → descent phase: T/D passed
 *  - vnav_td_dist > 0            → T/D ahead by that many NM along the route
 *  - vnav_td_dist <= 0           → T/D passed by |value| NM
 */
export function interpretTod(status: SimStatus): TodInfo {
  if (status.link !== 'connected' && status.lastContactAt === null) {
    return { status: 'unavailable', distanceNm: null, detail: 'Not connected to X-Plane.', source: null };
  }
  const { available, values } = status;
  if (!available.has('ziboTdDist') || !available.has('ziboTdIdx')) {
    return {
      status: 'unavailable',
      distanceNm: null,
      detail: 'T/D needs the Zibo 737 FMC datarefs, which are not loaded.',
      source: null,
    };
  }
  const dist = num(values.ziboTdDist);
  const idx = num(values.ziboTdIdx);
  const phase = num(values.ziboFlightPhase);
  if (dist === null || idx === null) {
    return { status: 'unavailable', distanceNm: null, detail: 'Waiting for FMC data…', source: TD_SOURCE };
  }
  if (idx === 0) {
    return {
      status: 'no_td',
      distanceNm: null,
      detail: 'FMC has no T/D. Enter a route with CRZ ALT and execute PERF INIT.',
      source: TD_SOURCE,
    };
  }
  if (dist >= 9999) {
    return { status: 'calculating', distanceNm: null, detail: 'FMC is calculating the descent path…', source: TD_SOURCE };
  }
  if (phase !== null && phase >= 5 && phase !== 8) {
    return { status: 'passed', distanceNm: null, detail: 'Descent phase: past T/D.', source: TD_SOURCE };
  }
  if (dist > 0) {
    return { status: 'ahead', distanceNm: round(dist, 1), detail: 'Along-track distance to T/D (Zibo FMC).', source: TD_SOURCE };
  }
  return { status: 'passed', distanceNm: round(Math.abs(dist), 1), detail: 'T/D passed.', source: TD_SOURCE };
}

export function buildControlInfo(cap: PauseCapability, inFlight: ControlInfo['inFlight']): ControlInfo {
  return { available: cap.ok, reason: cap.reason, inFlight, commandMode: cap.mode };
}

export function buildPublicState(
  status: SimStatus,
  cap: PauseCapability,
  inFlight: ControlInfo['inFlight'],
  now: number,
  staleMs: number,
): PublicState {
  return {
    serverTime: now,
    source: status.source,
    link: status.link,
    linkDetail: status.linkDetail,
    xplaneVersion: status.xplaneVersion,
    apiVersion: status.apiVersion,
    telemetry: buildTelemetry(status, now, staleMs),
    tod: interpretTod(status),
    control: buildControlInfo(cap, inFlight),
  };
}
