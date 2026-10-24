// API contract shared by the server and the React client.
// The client imports this file with `import type` only, so nothing here may
// have runtime behaviour.

/** Where the data comes from. `mock` is the development simulator and is never live. */
export type DataSource = 'xplane' | 'mock';

/**
 * Link to the simulator:
 * - `disconnected`: X-Plane's Web API is not reachable (sim closed, starting, or API disabled).
 * - `connecting`:   reachable, discovering datarefs/commands or opening the WebSocket.
 * - `no_flight`:    reachable but no flight is loaded (X-Plane exposes no datarefs yet).
 * - `connected`:    datarefs resolved and the telemetry WebSocket is open.
 */
export type SimLink = 'disconnected' | 'connecting' | 'no_flight' | 'connected';

export interface Telemetry {
  /** True when X-Plane has answered within the stale window. Values are last-known otherwise. */
  fresh: boolean;
  /** Epoch ms of the last confirmed contact with X-Plane (WebSocket update or REST read). */
  lastUpdate: number | null;
  ageMs: number | null;
  paused: boolean | null;
  /** Indicated altitude, pilot side (sim/cockpit2/gauges/indicators/altitude_ft_pilot), feet. */
  altitudeFt: number | null;
  /** Geometric altitude above MSL (sim/flightmodel/position/elevation), converted to feet. */
  trueAltitudeFt: number | null;
  /** Ground speed (sim/flightmodel/position/groundspeed), converted from m/s to knots. */
  groundspeedKt: number | null;
  /** Indicated airspeed, pilot side, knots. */
  iasKt: number | null;
  /** Magnetic heading (sim/flightmodel/position/mag_psi), degrees 0–360. */
  headingMagDeg: number | null;
  /** Indicated vertical speed, pilot side, feet per minute. */
  verticalSpeedFpm: number | null;
  latitude: number | null;
  longitude: number | null;
  aircraftName: string | null;
  aircraftIcao: string | null;
}

export type TodStatus =
  | 'unavailable' // datarefs not present (not a Zibo 737, or not connected)
  | 'no_td' // Zibo FMC has no T/D (no route / CRZ ALT / PERF INIT executed)
  | 'calculating' // Zibo FMC is recalculating the VNAV path
  | 'ahead' // T/D is ahead by distanceNm
  | 'passed'; // T/D is behind the aircraft (descent started / past T/D)

export interface TodInfo {
  status: TodStatus;
  /** Along-track distance in nautical miles. Present for `ahead`, optional for `passed`. */
  distanceNm: number | null;
  /** Human-readable explanation for the UI. */
  detail: string;
  /** Dataref the value came from, for transparency. */
  source: string | null;
}

export interface DestInfo {
  /** False when there is no Zibo route/destination to work from. */
  available: boolean;
  icao: string | null;
  /** Along-route distance to destination from the Zibo FMC (NM). */
  distanceNm: number | null;
  /** Live estimate: route distance ÷ current ground speed. Null below 60 kt. */
  liveEtaMinutes: number | null;
  /** Real-world clock time for the live estimate (epoch ms), so the phone can show local time. */
  liveEtaAt: number | null;
  /** The FMC's own ETA ("HHMM", sim Zulu) and the minutes until it by the sim clock. */
  fmcEtaZulu: string | null;
  fmcEtaMinutes: number | null;
  detail: string;
}

export type PauseAction = 'pause' | 'resume';

export interface ControlInfo {
  available: boolean;
  reason: string | null;
  inFlight: PauseAction | null;
  /** Which X-Plane command will be used: idempotent on/off pair, or the toggle. */
  commandMode: 'on_off' | 'toggle' | null;
}

export interface PublicState {
  serverTime: number;
  source: DataSource;
  link: SimLink;
  linkDetail: string | null;
  xplaneVersion: string | null;
  apiVersion: string | null;
  telemetry: Telemetry;
  tod: TodInfo;
  dest: DestInfo;
  control: ControlInfo;
}

export type PauseErrorCode =
  | 'unavailable' // not connected / command not found / API too old
  | 'read_failed' // could not read sim/time/paused before acting
  | 'command_failed' // X-Plane rejected or did not answer the command request
  | 'unconfirmed' // command sent but X-Plane did not report the expected state in time
  | 'busy'; // a different pause/resume request is already running

export type PauseResponse =
  | {
      ok: true;
      action: PauseAction;
      /** `changed`: command sent and new state confirmed. `already`: no command needed. */
      result: 'changed' | 'already';
      paused: boolean;
      confirmedAt: number;
      elapsedMs: number;
      command: string | null;
    }
  | {
      ok: false;
      action: PauseAction;
      error: PauseErrorCode;
      message: string;
      /** Last state actually read from X-Plane, or null when unknown. */
      paused: boolean | null;
    };

export interface SessionInfo {
  authenticated: boolean;
  expiresAt: number | null;
}

export interface WebFmcStatus {
  enabled: boolean;
  /** WebFMC answered on its local port. */
  reachable: boolean;
  /** The app can show WebFMC in an iframe through its same-origin proxy. */
  embeddable: boolean;
  /** Path of the same-origin proxy (valid when reachable and embeddable). */
  proxyPath: string;
  /** Optional direct URL from WEBFMC_DIRECT_URL, for opening WebFMC separately. */
  directUrl: string | null;
  reason: string | null;
  checkedAt: number;
}

export interface ApiError {
  error: string;
  message: string;
}
