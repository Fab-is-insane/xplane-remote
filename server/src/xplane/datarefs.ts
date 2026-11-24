// Catalog of the datarefs and commands this app uses, by NAME.
// Numeric IDs are session-specific in X-Plane and are always discovered at
// runtime through the Web API — never stored here or in configuration.
//
// Names, types and units were checked against X-Plane 12.4.3's
// Resources/plugins/DataRefs.txt and Commands.txt, and the Zibo 737 (4.05.33)
// datarefs against plugins/xlua/scripts/B738.a_fms/B738.a_fms.lua, and the
// FlightFactor 777v2 CDU datarefs against its docs/cduDatarefs.txt and the
// live sim, and the ToLiss A321 (v1.3.2) datarefs against the live sim.

/**
 * - number:   scalar int/float/double
 * - string:   byte array decoded as text, cut at the first NUL (names, ICAO codes)
 * - screen:   byte array decoded at full length, NUL → space (CDU screen text)
 * - intArray: int array (CDU colours / sizes)
 * - line:     byte array decoded as one display line: cut at the first NUL, NOT trimmed
 *             (leading spaces are column positions), control/high bytes → space
 */
export type DatarefKind = 'number' | 'string' | 'screen' | 'intArray' | 'line';

export type TelemetryValue = number | string | number[];

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
  | 'ziboDestIcao'
  | 'ffCduLines'
  | 'ffCduCols'
  | 'ffCduL'
  | 'ffCduC'
  | 'ffCduR'
  | 'ffCduLColor'
  | 'ffCduCColor'
  | 'ffCduRColor'
  | 'ffCduLSize'
  | 'ffCduCSize'
  | 'ffCduRSize'
  | 'tlDistDest'
  | 'tlDestIcao'
  | 'tlCruiseAlt'
  | 'tlFmgsPhase'
  | TolissMcduKey;

// ToLiss MCDU screen: one dataref per line and colour, for MCDU1 (captain) and MCDU2 (F/O).
//   title (large) + stitle (small)                → row 0
//   label1..6 (small)                             → rows 1, 3, …, 11
//   cont1..6 (large) + scont1..6 (small)          → rows 2, 4, …, 12
//   sp (scratchpad, large)                        → row 13
// Colour suffix: w white, g green, b blue (cyan), y yellow, a amber, m magenta,
// s special symbols (e.g. A/B = [ ] brackets). Each layer is a left-aligned
// string; a space means "nothing in this layer here".
export type TolissMcduColor = 'w' | 'g' | 'b' | 'y' | 'a' | 'm' | 's';
type TolissLineNo = 1 | 2 | 3 | 4 | 5 | 6;
export type TolissMcduField =
  | `title${'w' | 'g' | 'y' | 'b' | 's'}`
  | `stitle${'w' | 'g' | 'y' | 'b'}`
  | `${'label' | 'cont' | 'scont'}${TolissLineNo}${TolissMcduColor}`
  | `sp${'a' | 'w'}`;
export type TolissMcduKey = `tl${1 | 2}_${TolissMcduField}`;

const TL_ALL_COLORS: readonly TolissMcduColor[] = ['w', 'g', 'b', 'y', 'a', 'm', 's'];
export const TOLISS_MCDU_FIELDS: readonly TolissMcduField[] = [
  ...(['w', 'g', 'y', 'b', 's'] as const).map((c) => `title${c}` as const),
  ...(['w', 'g', 'y', 'b'] as const).map((c) => `stitle${c}` as const),
  ...(['label', 'cont', 'scont'] as const).flatMap((p) =>
    ([1, 2, 3, 4, 5, 6] as const).flatMap((i) => TL_ALL_COLORS.map((c) => `${p}${i}${c}` as const)),
  ),
  ...(['a', 'w'] as const).map((c) => `sp${c}` as const),
];

/** Which add-on a dataref belongs to. Each family is discovered with one batch request. */
export type DatarefFamily = 'core' | 'zibo' | 'ziboDest' | 'ff777' | 'toliss' | 'tolissMcdu';

export interface DatarefSpec {
  key: TelemetryKey;
  name: string;
  kind: DatarefKind;
  /** `aircraft` datarefs belong to an add-on and can appear/disappear when the aircraft changes. */
  group: 'sim' | 'aircraft';
  /** Discovery batch (default `core`). The first spec of a family is its probe. */
  family?: DatarefFamily;
  /** Without it the app cannot report sim state at all. */
  required?: boolean;
  unit: string;
}

// value_type strings reported by the Web API that we accept for each kind.
// Anything else is rejected so a changed dataref can't feed garbage into the UI.
export const ACCEPTED_VALUE_TYPES: Record<DatarefKind, readonly string[]> = {
  number: ['int', 'float', 'double'],
  string: ['data'],
  screen: ['data'],
  intArray: ['int_array'],
  line: ['data'],
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
  { key: 'ziboTdDist', name: 'laminar/B738/fms/vnav_td_dist', kind: 'number', group: 'aircraft', family: 'zibo', unit: 'nm' },
  // Index of the leg containing T/D; 0 = no T/D computed.
  { key: 'ziboTdIdx', name: 'laminar/B738/fms/vnav_td_idx', kind: 'number', group: 'aircraft', family: 'zibo', unit: 'index' },
  // Zibo FMS flight phase (2 = cruise; < 5 before descent; 8 = special case used with T/D).
  { key: 'ziboFlightPhase', name: 'laminar/B738/FMS/flight_phase', kind: 'number', group: 'aircraft', family: 'zibo', unit: 'enum' },
  // Zibo FMC: NM to destination along the route (sum of remaining legs from the aircraft).
  { key: 'ziboDestDist', name: 'laminar/B738/FMS/dist_dest', kind: 'number', group: 'aircraft', family: 'ziboDest', unit: 'nm' },
  // Zibo FMC: its own predicted arrival time, "HHMM" in sim Zulu time ("" when unknown).
  { key: 'ziboDestEta', name: 'laminar/B738/FMS/time_dest', kind: 'string', group: 'aircraft', family: 'ziboDest', unit: 'HHMM' },
  { key: 'ziboDestIcao', name: 'laminar/B738/fms/dest_icao', kind: 'string', group: 'aircraft', family: 'ziboDest', unit: 'text' },

  // FlightFactor 777v2 (docs/cduDatarefs.txt). Its FMC exposes no route/T/D/ETA
  // datarefs, but it publishes the exact text of each CDU screen (left, centre,
  // right): 14 lines × 24 chars, plus per-character colour and size. T/D and
  // destination ETA are read from whichever CDU shows PROGRESS page 1.
  { key: 'ffCduLines', name: '1-sim/cduL/display/numOfLines', kind: 'number', group: 'aircraft', family: 'ff777', unit: 'lines' },
  { key: 'ffCduCols', name: '1-sim/cduL/display/numOfSymbolsInLine', kind: 'number', group: 'aircraft', family: 'ff777', unit: 'chars' },
  { key: 'ffCduL', name: '1-sim/cduL/display/symbols', kind: 'screen', group: 'aircraft', family: 'ff777', unit: 'text' },
  { key: 'ffCduC', name: '1-sim/cduC/display/symbols', kind: 'screen', group: 'aircraft', family: 'ff777', unit: 'text' },
  { key: 'ffCduR', name: '1-sim/cduR/display/symbols', kind: 'screen', group: 'aircraft', family: 'ff777', unit: 'text' },
  // 1 white, 2 magenta, 3 green, 4 cyan, 5 grey, 6 blue
  { key: 'ffCduLColor', name: '1-sim/cduL/display/symbolsColor', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },
  { key: 'ffCduCColor', name: '1-sim/cduC/display/symbolsColor', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },
  { key: 'ffCduRColor', name: '1-sim/cduR/display/symbolsColor', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },
  // 1 normal, 2 small
  { key: 'ffCduLSize', name: '1-sim/cduL/display/symbolsSize', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },
  { key: 'ffCduCSize', name: '1-sim/cduC/display/symbolsSize', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },
  { key: 'ffCduRSize', name: '1-sim/cduR/display/symbolsSize', kind: 'intArray', group: 'aircraft', family: 'ff777', unit: 'enum[]' },

  // ToLiss A321 (AirbusFBW plugin). Checked live 2026-11-21 (A321neo, VABB → VIDP).
  // FMS distance to destination along the flight plan; matches the F-PLN DEST "DIST".
  { key: 'tlDistDest', name: 'AirbusFBW/DistToDest', kind: 'number', group: 'aircraft', family: 'toliss', unit: 'nm' },
  { key: 'tlDestIcao', name: 'toliss_airbus/flightplan/destination_icao', kind: 'string', group: 'aircraft', family: 'toliss', unit: 'text' },
  // INIT A cruise altitude in feet (35000 = FL350).
  { key: 'tlCruiseAlt', name: 'toliss_airbus/init/cruise_alt', kind: 'number', group: 'aircraft', family: 'toliss', unit: 'ft' },
  // FMGS flight phase: 0 preflight, 1 takeoff, 2 climb, 3 cruise, 4 descent, 5 approach, 6 go-around, 7 done.
  { key: 'tlFmgsPhase', name: 'AirbusFBW/APPhase', kind: 'number', group: 'aircraft', family: 'toliss', unit: 'enum' },
  // MCDU1 / MCDU2 screen layers (see TolissMcduKey above).
  ...([1, 2] as const).flatMap((n) =>
    TOLISS_MCDU_FIELDS.map(
      (f): DatarefSpec => ({
        key: `tl${n}_${f}`,
        name: `AirbusFBW/MCDU${n}${f}`,
        kind: 'line',
        group: 'aircraft',
        family: 'tolissMcdu',
        unit: 'text',
      }),
    ),
  ),
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

/** Decode a byte-array value at full length (NUL → space), e.g. a CDU screen. */
export function decodeScreen(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64').toString('latin1').replace(/[\x00-\x1f\x7f-\xff]/g, ' ');
  } catch {
    return null;
  }
}

/** Decode one display line (ToLiss MCDU layer): cut at the first NUL, keep leading spaces. */
export function decodeLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('latin1');
    const nul = text.indexOf('\0');
    return (nul >= 0 ? text.slice(0, nul) : text).replace(/[\x00-\x1f\x7f-\xff]/g, ' ').slice(0, 64);
  } catch {
    return null;
  }
}

/** Normalise a raw Web API value according to the dataref kind. Returns null if invalid. */
export function normaliseValue(spec: DatarefSpec, value: unknown): TelemetryValue | null {
  switch (spec.kind) {
    case 'string':
      return decodeDataString(value);
    case 'screen':
      return decodeScreen(value);
    case 'line':
      return decodeLine(value);
    case 'intArray':
      return Array.isArray(value) && value.length <= 4096 && value.every((x) => Number.isInteger(x)) ? (value as number[]) : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
