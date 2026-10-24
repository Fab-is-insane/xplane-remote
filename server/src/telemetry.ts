// Turns raw simulator values into the PublicState the client renders.
// Unit conversion and the Zibo T/D interpretation live here so they are
// covered by unit tests.

import type { ControlInfo, DestInfo, PublicState, Telemetry, TodInfo } from './shared/api-types.js';
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

/** Minimum ground speed for a distance ÷ speed estimate to mean anything. */
const MIN_ETA_GS_KT = 60;

/**
 * Destination ETA from the Zibo FMC route plus live telemetry:
 *  - live:  laminar/B738/FMS/dist_dest ÷ current ground speed → minutes and a real clock time
 *  - FMC:   laminar/B738/FMS/time_dest ("HHMM" Zulu) vs sim/time/zulu_time_sec → minutes
 */
export function interpretDest(status: SimStatus, now: number): DestInfo {
  const v = status.values;
  const none = (detail: string): DestInfo => ({
    available: false,
    icao: null,
    distanceNm: null,
    liveEtaMinutes: null,
    liveEtaAt: null,
    fmcEtaZulu: null,
    fmcEtaMinutes: null,
    detail,
  });
  if (!status.available.has('ziboDestDist')) return none('Destination data needs the Zibo 737 FMC.');
  const dist = num(v.ziboDestDist);
  if (dist === null || dist <= 0) return none('No route in the FMC.');

  const gsMs = num(v.groundspeedMs);
  const gsKt = gsMs === null ? null : gsMs * KT_PER_MS;
  let liveEtaMinutes: number | null = null;
  if (gsKt !== null && gsKt >= MIN_ETA_GS_KT) liveEtaMinutes = (dist / gsKt) * 60;

  const etaRaw = str(v.ziboDestEta);
  const m = etaRaw?.match(/^(\d{2})(\d{2})/);
  let fmcEtaZulu: string | null = null;
  let fmcEtaMinutes: number | null = null;
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 24 && mm < 60) {
      fmcEtaZulu = `${m[1]}${m[2]}`;
      const zulu = num(v.zuluTimeSec);
      if (zulu !== null) {
        const diffMin = ((hh * 3600 + mm * 60 - zulu + 86400) % 86400) / 60;
        // A wrap to ~24 h means the FMC time is just behind the clock: treat as arriving now.
        fmcEtaMinutes = diffMin > 20 * 60 ? 0 : diffMin;
      }
    }
  }

  return {
    available: true,
    icao: str(v.ziboDestIcao),
    distanceNm: round(dist, 1),
    liveEtaMinutes: round(liveEtaMinutes, 1),
    liveEtaAt: liveEtaMinutes === null ? null : Math.round(now + liveEtaMinutes * 60_000),
    fmcEtaZulu,
    fmcEtaMinutes: round(fmcEtaMinutes, 0),
    detail:
      liveEtaMinutes === null
        ? 'Live ETA needs ground speed above 60 kt.'
        : 'Live ETA = FMC route distance ÷ current ground speed.',
  };
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
    dest: interpretDest(status, now),
    control: buildControlInfo(cap, inFlight),
  };
}
