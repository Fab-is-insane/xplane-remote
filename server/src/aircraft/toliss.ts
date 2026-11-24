// ToLiss A321 (also the A319/A320/A340 family, which share the AirbusFBW plugin).
//
// The FMS publishes distance to destination, destination ICAO, CRZ FL and the
// FMGS flight phase as datarefs (see xplane/datarefs.ts). There is no T/D or
// ETA dataref: the ETA is read from the DEST line of the F-PLN page when an
// MCDU shows it, and T/D is estimated in telemetry.ts.
//
// The MCDU screen comes as one string dataref per line and colour
// (AirbusFBW/MCDU{1,2}{title,stitle,label1-6,cont1-6,scont1-6,sp}{w,g,b,y,a,m,s}).
// They are merged here into the same 14 × 24 screen + colour/size codes the
// FF777 mirror uses. F-PLN as captured live (2026-11-21, climb out of VABB):
//    | FROM          6488   ↑↓|
//    |        TIME  SPD/ALT   |
//    |MB877   1555  250/  FL90|
//    | ALBA2B BRG357°  18NM   |
//    |…                       |
//    |(T/C)   1611   " / FL350|
//    |DEST    UTC   DIST  EFOB|
//    |VIDP11L 1724   596   3.0|

import type { CduScreen, CduSide } from '../shared/api-types.js';
import type { TelemetryKey, TelemetryValue, TolissMcduColor, TolissMcduField } from '../xplane/datarefs.js';

type Values = Partial<Record<TelemetryKey, TelemetryValue>>;

export const TL_ROWS = 14;
export const TL_COLS = 24;

/** Mirror colour codes (shared with the FF777): 1 white 2 magenta 3 green 4 cyan 7 amber 8 yellow. */
const COLOR_CODE: Record<TolissMcduColor, string> = { w: '1', m: '2', g: '3', b: '4', a: '7', y: '8', s: '1' };
const COLORS: readonly TolissMcduColor[] = ['w', 'g', 'b', 'y', 'a', 'm', 's'];

/**
 * Symbols in the `s` (special) layer. A/B = [ ] is confirmed (PROG "UPDATE AT
 * *[    ]"); the arrows are the usual MCDU slew/scroll arrows (best guess at
 * which digit is which; cosmetic only).
 */
const SPECIAL: Readonly<Record<string, string>> = { A: '[', B: ']', '0': '←', '1': '→', '2': '↑', '3': '↓', E: '☐' };
/** In every layer: ` is the degree sign and # an amber entry box. */
const COMMON: Readonly<Record<string, string>> = { '`': '°', '#': '☐' };

type Layer = { field: 'title' | 'stitle' | 'label' | 'cont' | 'scont' | 'sp'; line?: number; small: boolean };

function rowLayers(row: number): Layer[] {
  if (row === 0) return [{ field: 'title', small: false }, { field: 'stitle', small: true }];
  if (row === TL_ROWS - 1) return [{ field: 'sp', small: false }];
  const line = Math.ceil(row / 2);
  return row % 2 === 1
    ? [{ field: 'label', line, small: true }]
    : [{ field: 'cont', line, small: false }, { field: 'scont', line, small: true }];
}

function layerKey(mcdu: 1 | 2, layer: Layer, color: TolissMcduColor): TelemetryKey {
  return `tl${mcdu}_${layer.field}${layer.line ?? ''}${color}` as `tl1_${TolissMcduField}`;
}

const SIDE: Record<1 | 2, CduSide> = { 1: 'L', 2: 'R' };

/** Merge the colour layers of one MCDU into a screen. Null if the aircraft publishes none. */
export function tolissScreen(values: Values, mcdu: 1 | 2): CduScreen | null {
  if (typeof values[`tl${mcdu}_titlew`] !== 'string' && typeof values[`tl${mcdu}_cont1w`] !== 'string') return null;
  const lines: string[] = [];
  const colors: string[] = [];
  const sizes: string[] = [];
  for (let row = 0; row < TL_ROWS; row++) {
    const ch = Array<string>(TL_COLS).fill(' ');
    const co = Array<string>(TL_COLS).fill('1');
    const sz = Array<string>(TL_COLS).fill('1');
    for (const layer of rowLayers(row)) {
      for (const color of COLORS) {
        const text = values[layerKey(mcdu, layer, color)];
        if (typeof text !== 'string') continue;
        for (let i = 0; i < Math.min(TL_COLS, text.length); i++) {
          const c = text[i]!;
          if (c === ' ' || ch[i] !== ' ') continue;
          ch[i] = (color === 's' ? SPECIAL[c] : undefined) ?? COMMON[c] ?? c;
          co[i] = COLOR_CODE[color];
          sz[i] = layer.small ? '2' : '1';
        }
      }
    }
    lines.push(ch.join(''));
    colors.push(co.join(''));
    sizes.push(sz.join(''));
  }
  const hasTd = parseTdLine(lines)?.distNm != null;
  const fpln = parseFplnDest(lines);
  return {
    side: SIDE[mcdu],
    lines,
    colors,
    sizes,
    isProgress: hasTd || fpln !== null,
    badge: hasTd ? 'T/D' : fpln ? 'F-PLN' : null,
  };
}

/** MCDU1 (captain, side L) and MCDU2 (F/O, side R), whichever are available. */
export function tolissScreens(values: Values): CduScreen[] {
  return ([1, 2] as const).map((n) => tolissScreen(values, n)).filter((s): s is CduScreen => s !== null);
}

export interface FplnDest {
  /** ICAO as printed (the runway suffix is cut off). */
  icao: string;
  /** "HHMM" UTC; null while the page shows TIME (flight time, before takeoff) or no value. */
  etaZulu: string | null;
  distNm: number | null;
}

/** The DEST line at the bottom of the F-PLN page. Null on any other page. */
export function parseFplnDest(lines: readonly string[]): FplnDest | null {
  for (let i = 1; i < lines.length - 1; i++) {
    const label = lines[i]!.match(/^\s*DEST\s+(UTC|TIME)\s+DIST\b/);
    if (!label) continue;
    const m = lines[i + 1]!.match(/^\s*([A-Z0-9]{4})\S*\s+(\d{4}|-{4})?\s*(\d+|-+)?/);
    if (!m) return null;
    const eta = label[1] === 'UTC' && m[2] && /^\d{4}$/.test(m[2]) && Number(m[2].slice(0, 2)) < 24 && Number(m[2].slice(2)) < 60 ? m[2] : null;
    const dist = m[3] && /^\d+$/.test(m[3]) ? Number(m[3]) : null;
    return { icao: m[1]!, etaZulu: eta, distNm: dist };
  }
  return null;
}

/** The first MCDU (1, then 2) showing F-PLN with a DEST line. */
export function findFplnDest(values: Values): (FplnDest & { side: CduSide }) | null {
  for (const s of tolissScreens(values)) {
    const d = parseFplnDest(s.lines);
    if (d) return { ...d, side: s.side };
  }
  return null;
}

export interface TdReading {
  /** "HHMM" UTC at which the FMS predicts T/D. */
  etaZulu: string | null;
  /** FMS distance to T/D, NM. */
  distNm: number | null;
  /** Cruise level the T/D belongs to, e.g. "FL350". */
  level: string | null;
}

/**
 * The FMS's own T/D figures. Two layouts, both captured live (2026-11-23):
 *
 *  PROG → REPORT: "T/D" in the heading line
 *    | T/D      UTC DIST      |
 *    |AT FL350 1309  507      |
 *
 *  PERF CRZ: a "TO (T/D)" marker on the line above the heading
 *    |12              TO (T/D)|
 *    | MANAGED   UTC      DIST|
 *    | 267/.78  1302       416|
 *
 * Values are read by column, under the UTC and DIST headings, so the parse
 * doesn't depend on exact spacing.
 */
export function parseTdLine(lines: readonly string[]): TdReading | null {
  for (let i = 1; i < lines.length - 1; i++) {
    const label = lines[i]!;
    const tdHeading = /(^|\s)T\/D(\s|$)/.test(label);
    const tdMarkerAbove = /\bTO\s+\(T\/D\)/.test(lines[i - 1] ?? '');
    if (!tdHeading && !tdMarkerAbove) continue;
    const utcCol = label.indexOf('UTC');
    const distCol = label.indexOf('DIST');
    if (utcCol < 0 || distCol < 0) continue;
    const data = lines[i + 1]!;
    const tokens = [...data.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
    const under = (col: number, width: number) => tokens.find((t) => t.start < col + width && t.end > col)?.text ?? null;
    const utc = under(utcCol, 3);
    const dist = under(distCol, 4);
    const etaZulu = utc && /^\d{4}$/.test(utc) && Number(utc.slice(0, 2)) < 24 && Number(utc.slice(2)) < 60 ? utc : null;
    const distNm = dist && /^\d+(\.\d+)?$/.test(dist) ? Number(dist) : null;
    // "AT FL350" / "AT 9000" on REPORT; PERF CRZ has none (its "1302" is a time, not a level).
    const level = data.match(/\bAT\s+(FL\d{2,3}|\d{4,5})\b/)?.[1] ?? null;
    return { etaZulu, distNm, level };
  }
  return null;
}

/** The first MCDU (1, then 2) showing the FMS T/D line with a distance. */
export function findTd(values: Values): (TdReading & { side: CduSide; page: string }) | null {
  for (const s of tolissScreens(values)) {
    const td = parseTdLine(s.lines);
    if (td && td.distNm !== null) return { ...td, side: s.side, page: pageName(s.lines[0] ?? '') };
  }
  return null;
}

/** Short page name from the title line ("REPORT", "PERF CRZ"…), for source labels. */
function pageName(title: string): string {
  const t = title.trim().replace(/\s+\d{3,}$/, ''); // drop the flight number
  if (/\bREPORT\b/.test(t)) return 'PROG REPORT';
  // PERF pages are titled by phase only ("CRZ", "ACT CRZ", …)
  const perf = t.match(/^(?:ACT\s+)?(TAKE OFF|CLB|CRZ|DES|APPR|GO AROUND)$/);
  return perf ? `PERF ${perf[1]}` : t || 'MCDU';
}

export const TOLISS_PHASE_NAMES: readonly string[] = ['PREFLIGHT', 'TAKEOFF', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH', 'GO AROUND', 'DONE'];
