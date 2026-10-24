// Catalog of the datarefs and commands this app uses, by NAME.
// Numeric IDs are session-specific in X-Plane and are always discovered at
// runtime through the Web API — never stored here or in configuration.
//
// Names, types and units were checked against X-Plane 12.4.3's
// Resources/plugins/DataRefs.txt and Commands.txt, and the Zibo 737 (4.05.33)
// datarefs against plugins/xlua/scripts/B738.a_fms/B738.a_fms.lua.

export type DatarefKind = 'number' | 'string';

export type TelemetryKey =
  | 'paused'
  | 'runningTime'
  | 'altitudeFt'
  | 'elevationM'
  | 'groundspeedMs'
  | 'iasKt'
  | 'headingMag'
  | 'vsFpm'
  | 'latitude'
  | 'longitude'
  | 'acfIcao'
  | 'acfName'
  | 'zuluTimeSec'
  | 'ziboTdDist'
  | 'ziboTdIdx'
  | 'ziboFlightPhase'
  | 'ziboDestDist'
  | 'ziboDestEta'
  | 'ziboDestIcao';

export interface DatarefSpec {
  key: TelemetryKey;
  name: string;
  kind: DatarefKind;
  /** `aircraft` datarefs belong to an add-on and can appear/disappear when the aircraft changes. */
  group: 'sim' | 'aircraft';
  /** Without it the app cannot report sim state at all. */
  required?: boolean;
  unit: string;
}

// value_type strings reported by the Web API that we accept for each kind.
// Scalar only: array types are rejected so a changed dataref can't feed
// garbage into the UI.
export const ACCEPTED_VALUE_TYPES: Record<DatarefKind, readonly string[]> = {
  number: ['int', 'float', 'double'],
  string: ['data'],
};

export const DATAREFS: readonly DatarefSpec[] = [
  // int, read-only, boolean. "Use cmd keys to change this." — never written.
  { key: 'paused', name: 'sim/time/paused', kind: 'number', group: 'sim', required: true, unit: 'bool' },
  // Ticks continuously, so the WebSocket produces updates even when the
  // aircraft is parked; used only as a liveness signal.
  { key: 'runningTime', name: 'sim/time/total_running_time_sec', kind: 'number', group: 'sim', unit: 's' },
  { key: 'altitudeFt', name: 'sim/cockpit2/gauges/indicators/altitude_ft_pilot', kind: 'number', group: 'sim', unit: 'ft' },
  { key: 'elevationM', name: 'sim/flightmodel/position/elevation', kind: 'number', group: 'sim', unit: 'm' },
  { key: 'groundspeedMs', name: 'sim/flightmodel/position/groundspeed', kind: 'number', group: 'sim', unit: 'm/s' },
  { key: 'iasKt', name: 'sim/cockpit2/gauges/indicators/airspeed_kts_pilot', kind: 'number', group: 'sim', unit: 'kt' },
  { key: 'headingMag', name: 'sim/flightmodel/position/mag_psi', kind: 'number', group: 'sim', unit: 'deg' },
  { key: 'vsFpm', name: 'sim/cockpit2/gauges/indicators/vvi_fpm_pilot', kind: 'number', group: 'sim', unit: 'fpm' },
  { key: 'latitude', name: 'sim/flightmodel/position/latitude', kind: 'number', group: 'sim', unit: 'deg' },
  { key: 'longitude', name: 'sim/flightmodel/position/longitude', kind: 'number', group: 'sim', unit: 'deg' },
  { key: 'acfIcao', name: 'sim/aircraft/view/acf_ICAO', kind: 'string', group: 'sim', unit: 'text' },
  { key: 'acfName', name: 'sim/aircraft/view/acf_ui_name', kind: 'string', group: 'sim', unit: 'text' },
  // Sim clock (seconds since midnight UTC), to turn the FMC's "HHMM" ETA into minutes remaining.
  { key: 'zuluTimeSec', name: 'sim/time/zulu_time_sec', kind: 'number', group: 'sim', unit: 's' },

  // Zibo 737-800 FMC (xlua). Along-track NM from the aircraft to T/D:
  // lnav_dist_next + remaining leg distances to the T/D leg − T/D offset.
  // 9999 = FMC recalculating; ≤ 0 = T/D passed. Same value the Zibo FMC
  // uses for its PROGRESS / LEGS "T/D" logic.
  { key: 'ziboTdDist', name: 'laminar/B738/fms/vnav_td_dist', kind: 'number', group: 'aircraft', unit: 'nm' },
  // Index of the leg containing T/D; 0 = no T/D computed.
  { key: 'ziboTdIdx', name: 'laminar/B738/fms/vnav_td_idx', kind: 'number', group: 'aircraft', unit: 'index' },
  // Zibo FMS flight phase (2 = cruise; < 5 before descent; 8 = special case used with T/D).
  { key: 'ziboFlightPhase', name: 'laminar/B738/FMS/flight_phase', kind: 'number', group: 'aircraft', unit: 'enum' },
  // Zibo FMC: NM to destination along the route (sum of remaining legs from the aircraft).
  { key: 'ziboDestDist', name: 'laminar/B738/FMS/dist_dest', kind: 'number', group: 'aircraft', unit: 'nm' },
  // Zibo FMC: its own predicted arrival time, "HHMM" in sim Zulu time ("" when unknown).
  { key: 'ziboDestEta', name: 'laminar/B738/FMS/time_dest', kind: 'string', group: 'aircraft', unit: 'HHMM' },
  { key: 'ziboDestIcao', name: 'laminar/B738/fms/dest_icao', kind: 'string', group: 'aircraft', unit: 'text' },
];

export const DATAREF_BY_NAME: ReadonlyMap<string, DatarefSpec> = new Map(DATAREFS.map((d) => [d.name, d]));

/** The only simulator commands this application will ever activate. */
export const PAUSE_COMMANDS = {
  toggle: 'sim/operation/pause_toggle',
  on: 'sim/operation/pause_on',
  off: 'sim/operation/pause_off',
} as const;

export const ALLOWED_COMMAND_NAMES: readonly string[] = Object.values(PAUSE_COMMANDS);

export const KT_PER_MS = 1.9438444924406;
export const FT_PER_M = 3.280839895;

/** Decode an X-Plane `data` (byte array) value: base64 → UTF-8, cut at the first NUL. */
export function decodeDataString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const nul = text.indexOf('\0');
    const trimmed = (nul >= 0 ? text.slice(0, nul) : text).trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}

/** Normalise a raw Web API value according to the dataref kind. Returns null if invalid. */
export function normaliseValue(spec: DatarefSpec, value: unknown): number | string | null {
  if (spec.kind === 'string') return decodeDataString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}
