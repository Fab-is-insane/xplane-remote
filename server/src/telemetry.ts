// Turns raw simulator values into the PublicState the client renders.
// Unit conversion and the per-aircraft T/D / ETA interpretation live here so
// they are covered by unit tests.

import { FF_CDU_KEYS, cduDataref, cduScreens, findProgress } from './aircraft/ff777.js';
import type { AircraftProfile, CduMirror, ControlInfo, DestInfo, PublicState, Telemetry, TodInfo } from './shared/api-types.js';
import { FT_PER_M, KT_PER_MS } from './xplane/datarefs.js';
import type { PauseCapability, SimStatus } from './xplane/simSource.js';

const TD_SOURCE = 'laminar/B738/fms/vnav_td_dist';
const ZIBO_DEST_SOURCE = 'laminar/B738/FMS/dist_dest + time_dest';

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
 * Which aircraft logic applies, decided by the datarefs that actually exist:
 * the Zibo's laminar/B738/... FMC datarefs, or the FlightFactor 777's 1-sim/cdu… screens.
 */
export function detectProfile(status: SimStatus): AircraftProfile {
  const zibo = status.available.has('ziboTdDist') || status.available.has('ziboDestDist');
  const ff = FF_CDU_KEYS.some((k) => status.available.has(k));
  if (zibo && ff) {
    // Should not happen (one aircraft at a time); let the ICAO decide.
    return str(status.values.acfIcao)?.startsWith('B77') ? 'ff777' : 'zibo737';
  }
  if (zibo) return 'zibo737';
  if (ff) return 'ff777';
  return 'generic';
}

const FF_NO_PROG = 'Open PROGRESS page 1 on any CDU (the centre CDU is ideal) to see T/D and ETA.';

export function interpretTod(status: SimStatus, flight: FlightContext | null = null): TodInfo {
  if (status.link !== 'connected' && status.lastContactAt === null) {
    return { status: 'unavailable', distanceNm: null, detail: 'Not connected to X-Plane.', source: null };
  }
  switch (detectProfile(status)) {
    case 'zibo737':
      return interpretZiboTod(status);
    case 'ff777':
      return interpretFfTod(status, flight);
    default:
      return {
        status: 'unavailable',
        distanceNm: null,
        detail: 'T/D needs the Zibo 737 or FlightFactor 777 FMC.',
        source: null,
      };
  }
}

/**
 * What the server remembers about the current flight between updates. Used
 * for the FF777 only: to tell "still at cruise" from "descending", it needs
 * the highest altitude reached this flight.
 */
export interface FlightContext {
  peakAltitudeFt: number | null;
}

/** On the ground below this ground speed: a new flight starts. */
const NEW_FLIGHT_GS_KT = 50;
/** A position jump this large between two updates means a new flight was loaded. */
const NEW_FLIGHT_JUMP_NM = 20;

export class FlightMemory implements FlightContext {
  private peak: number | null = null;
  private icao: string | null = null;
  private lastPos: { lat: number; lon: number } | null = null;

  get peakAltitudeFt(): number | null {
    return this.peak;
  }

  observe(status: SimStatus): void {
    const v = status.values;
    const icao = str(v.acfIcao);
    if (icao !== this.icao) {
      this.icao = icao;
      this.peak = null;
    }
    const lat = num(v.latitude);
    const lon = num(v.longitude);
    if (lat !== null && lon !== null) {
      if (this.lastPos && distanceNm(this.lastPos, { lat, lon }) > NEW_FLIGHT_JUMP_NM) this.peak = null;
      this.lastPos = { lat, lon };
    }
    const gsMs = num(v.groundspeedMs);
    if (gsMs !== null && gsMs * KT_PER_MS < NEW_FLIGHT_GS_KT) {
      this.peak = null;
      return;
    }
    const alt = num(v.altitudeFt);
    if (alt !== null) this.peak = this.peak === null ? alt : Math.max(this.peak, alt);
  }
}

function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 3440.065;
}

// FF777 T/D estimate. Its FMC only draws T/D as a green circle on the ND and
// PROGRESS shows E/D (or STEP CLB), so the distance is estimated from the
// DEST distance-to-go and the current altitude with the standard rule of
// thumb: 3 NM per 1000 ft to lose, plus 10 NM to slow down. Field elevation
// is ignored, which errs early (the safe side for "be back before T/D").
const FF_NM_PER_1000FT = 3;
const FF_DECEL_NM = 10;
/** Left cruise: this far below the highest altitude of the flight. */
const FF_LEFT_CRUISE_FT = 2500;
/** Descending at least this fast, close to the estimated T/D, also counts as past it. */
const FF_DESCENT_FPM = -500;
const FF_DESCENT_NEAR_NM = 30;

/**
 * FlightFactor 777, from PROGRESS page 1 plus live altitude:
 *  - TO T/C               → still climbing
 *  - TO T/D hhmmZ/ nnnNM → T/D ahead by nnn NM (FMC value, if the FMC ever shows it)
 *  - otherwise (TO E/D, TO STEP CLB, nothing): estimate from DEST DTG and altitude;
 *    passed once the aircraft has left cruise altitude or is descending near T/D.
 */
function interpretFfTod(status: SimStatus, flight: FlightContext | null): TodInfo {
  const v = status.values;
  const prog = findProgress(v);
  if (!prog) return { status: 'unavailable', distanceNm: null, detail: FF_NO_PROG, source: null };
  const source = `${cduDataref(prog.side)} · PROGRESS 1`;
  const next = prog.next;
  if (next?.kind === 'T/C') {
    return { status: 'climb', distanceNm: null, detail: 'Climbing: T/D is shown after top of climb.', source };
  }
  if (next?.kind === 'T/D' && next.distNm !== null) {
    return { status: 'ahead', distanceNm: round(next.distNm, 1), detail: 'along route // ff777 fmc (PROGRESS)', source };
  }

  const dest = prog.dest;
  if (!dest || dest.dtgNm <= 0) {
    return { status: 'no_td', distanceNm: null, detail: 'PROGRESS shows no destination, so T/D cannot be estimated.', source };
  }
  const estSource = `${source} DEST + altitude_ft_pilot`;
  const alt = num(v.altitudeFt);
  if (alt === null) return { status: 'calculating', distanceNm: null, detail: 'Waiting for altitude…', source: estSource };

  const est = dest.dtgNm - ((Math.max(0, alt) / 1000) * FF_NM_PER_1000FT + FF_DECEL_NM);
  const peak = flight?.peakAltitudeFt ?? null;
  const vs = num(v.vsFpm);
  const leftCruise = peak !== null && alt < peak - FF_LEFT_CRUISE_FT;
  const descendingNearTd = vs !== null && vs <= FF_DESCENT_FPM && est <= FF_DESCENT_NEAR_NM;
  if (leftCruise || descendingNearTd) {
    const from = peak !== null && peak >= 10000 ? ` from FL${Math.round(peak / 100)}` : '';
    return { status: 'passed', distanceNm: null, detail: `Descending${from}: past T/D.`, source: estSource };
  }
  if (est <= 0) {
    return {
      status: 'ahead',
      distanceNm: 0,
      detail: 'T/D due now (est.) // check the green T/D circle on the ND',
      source: estSource,
      estimated: true,
    };
  }
  return {
    status: 'ahead',
    distanceNm: round(est, 0),
    detail: 'est. 3 NM/1000 ft + 10 from DEST DTG // ND T/D circle may differ a little',
    source: estSource,
    estimated: true,
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
function interpretZiboTod(status: SimStatus): TodInfo {
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
    return { status: 'ahead', distanceNm: round(dist, 1), detail: 'along route // zibo fmc', source: TD_SOURCE };
  }
  return { status: 'passed', distanceNm: round(Math.abs(dist), 1), detail: 'T/D passed.', source: TD_SOURCE };
}

/** Minimum ground speed for a distance ÷ speed estimate to mean anything. */
const MIN_ETA_GS_KT = 60;

interface RouteFacts {
  icao: string | null;
  distNm: number;
  etaZulu: string | null;
  source: string;
}

function noDest(detail: string): DestInfo {
  return {
    available: false,
    icao: null,
    distanceNm: null,
    liveEtaMinutes: null,
    liveEtaAt: null,
    fmcEtaZulu: null,
    fmcEtaMinutes: null,
    detail,
    source: null,
  };
}

/**
 * Destination ETA from the FMC route plus live telemetry, for either aircraft:
 *  - live: FMC distance-to-go ÷ current ground speed → minutes and a real clock time
 *  - FMC:  the FMC's own "HHMM" Zulu ETA vs sim/time/zulu_time_sec → minutes
 * Route facts come from laminar/B738/FMS/dist_dest + time_dest (Zibo) or the
 * DEST line of PROGRESS page 1 (FF777).
 */
export function interpretDest(status: SimStatus, now: number): DestInfo {
  const v = status.values;
  let facts: RouteFacts;
  switch (detectProfile(status)) {
    case 'zibo737': {
      if (!status.available.has('ziboDestDist')) return noDest('Destination data needs the Zibo 737 FMC.');
      const dist = num(v.ziboDestDist);
      if (dist === null || dist <= 0) return noDest('No route in the FMC.');
      facts = { icao: str(v.ziboDestIcao), distNm: dist, etaZulu: str(v.ziboDestEta), source: ZIBO_DEST_SOURCE };
      break;
    }
    case 'ff777': {
      const prog = findProgress(v);
      if (!prog) return noDest(FF_NO_PROG);
      if (!prog.dest || prog.dest.dtgNm <= 0) return noDest('No destination on the FMC PROGRESS page.');
      facts = {
        icao: prog.dest.icao,
        distNm: prog.dest.dtgNm,
        etaZulu: prog.dest.etaZulu,
        source: `${cduDataref(prog.side)} · PROGRESS 1 DEST`,
      };
      break;
    }
    default:
      return noDest('Destination data needs the Zibo 737 or FlightFactor 777 FMC.');
  }

  const gsMs = num(v.groundspeedMs);
  const gsKt = gsMs === null ? null : gsMs * KT_PER_MS;
  let liveEtaMinutes: number | null = null;
  if (gsKt !== null && gsKt >= MIN_ETA_GS_KT) liveEtaMinutes = (facts.distNm / gsKt) * 60;

  const m = facts.etaZulu?.match(/^(\d{2})(\d{2})/);
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
    icao: facts.icao,
    distanceNm: round(facts.distNm, 1),
    liveEtaMinutes: round(liveEtaMinutes, 1),
    liveEtaAt: liveEtaMinutes === null ? null : Math.round(now + liveEtaMinutes * 60_000),
    fmcEtaZulu,
    fmcEtaMinutes: round(fmcEtaMinutes, 0),
    detail:
      liveEtaMinutes === null
        ? 'Live ETA needs ground speed above 60 kt.'
        : 'Live ETA = FMC route distance ÷ current ground speed.',
    source: facts.source,
  };
}

/** Read-only CDU mirror for the FF777 (WebFMC does not support it). Null for other aircraft. */
export function buildCduMirror(status: SimStatus): CduMirror | null {
  if (detectProfile(status) !== 'ff777') return null;
  const screens = cduScreens(status.values);
  return screens.length ? { aircraft: 'ff777', screens } : null;
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
  flight: FlightContext | null = null,
): PublicState {
  return {
    serverTime: now,
    source: status.source,
    link: status.link,
    linkDetail: status.linkDetail,
    xplaneVersion: status.xplaneVersion,
    apiVersion: status.apiVersion,
    profile: detectProfile(status),
    telemetry: buildTelemetry(status, now, staleMs),
    tod: interpretTod(status, flight),
    dest: interpretDest(status, now),
    control: buildControlInfo(cap, inFlight),
  };
}
