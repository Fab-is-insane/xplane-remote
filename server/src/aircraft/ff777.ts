// FlightFactor 777v2 support.
//
// The FF777 FMC does not publish route, T/D or ETA datarefs. What it does
// publish (docs/cduDatarefs.txt) is the exact content of each CDU screen:
//   1-sim/cdu{L,C,R}/display/symbols        char[lines × cols]
//   1-sim/cdu{L,C,R}/display/symbolsColor   int[]  1 white 2 magenta 3 green 4 cyan 5 grey 6 blue
//   1-sim/cdu{L,C,R}/display/symbolsSize    int[]  1 normal 2 small
// Destination data are read from whichever CDU shows PROGRESS page 1, i.e.
// exactly the numbers the FMC itself displays. Nothing is estimated here; the
// T/D estimate (the FF777 shows T/D only on the ND) lives in telemetry.ts.
//
// PROGRESS 1/2 as captured from the live aircraft (descent into VIDP):
//    |  UAE1234 PROGRESS  1/2 |
//    | TO      DTG  ETA   FUEL|
//    |FS817     12 1356Z   8.0|
//    | NEXT                   |
//    |DP502     25 1359Z   7.7|
//    | DEST                   |
//    |VIDP      60 1409Z   7.3|
//    | TGT SPD          TO E/D|
//    |250         1409Z/  58NM|
// In cruise the bottom pair reads "TO STEP CLB" or "TO E/D" (not T/D), and in climb "TO T/C".

import type { CduScreen, CduSide } from '../shared/api-types.js';
import type { TelemetryKey, TelemetryValue } from '../xplane/datarefs.js';

type Values = Partial<Record<TelemetryKey, TelemetryValue>>;

const SIDES: ReadonlyArray<{ side: CduSide; text: TelemetryKey; color: TelemetryKey; size: TelemetryKey }> = [
  // Order = preference when several CDUs show PROGRESS: centre, right, left.
  { side: 'C', text: 'ffCduC', color: 'ffCduCColor', size: 'ffCduCSize' },
  { side: 'R', text: 'ffCduR', color: 'ffCduRColor', size: 'ffCduRSize' },
  { side: 'L', text: 'ffCduL', color: 'ffCduLColor', size: 'ffCduLSize' },
];

export const FF_CDU_KEYS: readonly TelemetryKey[] = ['ffCduL', 'ffCduC', 'ffCduR'];

export function cduDataref(side: CduSide): string {
  return `1-sim/cdu${side}/display/symbols`;
}

function dims(values: Values): { lines: number; cols: number } {
  const l = values.ffCduLines;
  const c = values.ffCduCols;
  const lines = typeof l === 'number' && l > 0 && l <= 30 ? l : 14;
  const cols = typeof c === 'number' && c > 0 && c <= 40 ? c : 24;
  return { lines, cols };
}

function splitLines(text: string, lines: number, cols: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(text.slice(i * cols, (i + 1) * cols).padEnd(cols, ' '));
  return out;
}

function arrayLines(arr: TelemetryValue | undefined, lines: number, cols: number): string[] | null {
  if (!Array.isArray(arr) || arr.length < lines * cols) return null;
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      arr
        .slice(i * cols, (i + 1) * cols)
        .map((n) => String(Math.min(9, Math.max(0, n))))
        .join(''),
    );
  }
  return out;
}

/** All CDU screens currently available, in the order L, C, R. */
export function cduScreens(values: Values): CduScreen[] {
  const { lines, cols } = dims(values);
  const out: CduScreen[] = [];
  for (const s of [SIDES[2]!, SIDES[0]!, SIDES[1]!]) {
    const text = values[s.text];
    if (typeof text !== 'string') continue;
    const screenLines = splitLines(text, lines, cols);
    const isProgress = isProgressPage1(screenLines);
    out.push({
      side: s.side,
      lines: screenLines,
      colors: arrayLines(values[s.color], lines, cols),
      sizes: arrayLines(values[s.size], lines, cols),
      isProgress,
      badge: isProgress ? 'PROG' : null,
    });
  }
  return out;
}

export function isProgressPage1(lines: readonly string[]): boolean {
  return /\bPROGRESS\s+1\/\d/.test(lines[0] ?? '');
}

export type FfLeg = 'T/D' | 'E/D' | 'T/C';

export interface ProgressReading {
  side: CduSide;
  dest: { icao: string; dtgNm: number; etaZulu: string | null } | null;
  /** The "TO T/D", "TO E/D" or "TO T/C" line, if shown. */
  next: { kind: FfLeg; etaZulu: string | null; distNm: number | null } | null;
}

/** Parse PROGRESS page 1. Returns null for any other page. */
export function parseProgress(lines: readonly string[], side: CduSide = 'C'): ProgressReading | null {
  if (!isProgressPage1(lines)) return null;
  let dest: ProgressReading['dest'] = null;
  let next: ProgressReading['next'] = null;

  for (let i = 1; i < lines.length - 1; i++) {
    const label = lines[i]!;
    const data = lines[i + 1]!;

    if (!dest && /^\s*DEST\b/.test(label)) {
      const m = data.match(/^\s*([A-Z0-9]{3,5})\s+(\d+(?:\.\d+)?)(?:\s+(\d{4})Z)?/);
      if (m) dest = { icao: m[1]!, dtgNm: Number(m[2]), etaZulu: m[3] ?? null };
    }

    const leg = label.match(/\bTO (T\/D|E\/D|T\/C)\b/);
    if (!next && leg) {
      const m = data.match(/(\d{4})Z\s*\/\s*(\d+(?:\.\d+)?)\s*NM/);
      next = { kind: leg[1] as FfLeg, etaZulu: m?.[1] ?? null, distNm: m ? Number(m[2]) : null };
    }
  }
  return { side, dest, next };
}

/** The first CDU (centre, right, left) that shows PROGRESS page 1, parsed. */
export function findProgress(values: Values): ProgressReading | null {
  const { lines, cols } = dims(values);
  for (const s of SIDES) {
    const text = values[s.text];
    if (typeof text !== 'string') continue;
    const r = parseProgress(splitLines(text, lines, cols), s.side);
    if (r) return r;
  }
  return null;
}
