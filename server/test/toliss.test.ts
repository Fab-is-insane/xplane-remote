import { describe, expect, it } from 'vitest';
import { findFplnDest, findTd, parseFplnDest, parseTdLine, tolissScreen, tolissScreens } from '../src/aircraft/toliss.js';
import { buildCduMirror, buildPublicState, detectProfile, interpretDest, interpretTod } from '../src/telemetry.js';
import type { TelemetryKey } from '../src/xplane/datarefs.js';
import type { SimStatus } from '../src/xplane/simSource.js';

// MCDU layer datarefs captured from the live ToLiss A321neo (2026-11-21,
// climbing out of VABB for VIDP): MCDU1 on F-PLN, MCDU2 on PROG.
export const MCDU_CAPTURE: SimStatus['values'] = {
  tl1_titlew: ' FROM          6488',
  tl1_titles: '                      23',
  tl1_label1w: '        TIME  SPD/ALT',
  tl1_label2w: ' ALBA2B BRG007`  11NM',
  tl1_label3g: '        TRK001`  26',
  tl1_label3w: ' Q1                  ',
  tl1_label4g: '                 29',
  tl1_label5g: '                 74',
  tl1_label5w: ' Q1                  ',
  tl1_label6w: 'DEST    UTC   DIST  EFOB',
  tl1_cont1g: 'MB361   1559  301/ FL165',
  tl1_cont2w: 'ISRIS                ',
  tl1_cont3g: 'DOSTO                   ',
  tl1_cont4g: '(T/C)                   ',
  tl1_cont5g: 'EGUGU                   ',
  tl1_cont6w: 'VIDP11L 1722   548   3.0',
  tl1_scont2w: '        1603  301/ FL257',
  tl1_scont3g: '        1606  .75/ FL308',
  tl1_scont4g: '        1610   " / FL350',
  tl1_scont5g: '        1620   " /   " ',
  tl2_titlew: '                 6488',
  tl2_titleg: '   CLIMB    ',
  tl2_label1w: ' CRZ      OPT    REC MAX',
  tl2_label3w: ' UPDATE AT',
  tl2_label4w: '  BRG/DIST',
  tl2_label5w: ' PREDICTIVE',
  tl2_label6w: 'REQUIRED ACCUR ESTIMATED',
  tl2_cont1b: 'FL350                  ',
  tl2_cont1g: '         FL359     ',
  tl2_cont1m: '                  FL373',
  tl2_cont2w: '<REPORT',
  tl2_cont3b: '*',
  tl2_cont3s: ' A    B',
  tl2_cont4s: '                 A     B',
  tl2_cont4w: ' ---` /----.-',
  tl2_cont5g: '             GPS PRIMARY',
  tl2_cont5w: '<GPS',
  tl2_cont6g: '          HIGH',
  tl2_scont4w: '              TO',
  tl2_scont6b: '1.0NM',
  tl2_scont6g: '                  0.04NM',
};

const KT = 1 / 1.9438444924406;

function status(values: SimStatus['values'], extra: Partial<SimStatus> = {}): SimStatus {
  const all = { acfIcao: 'A321', ...values };
  return {
    source: 'xplane',
    link: 'connected',
    linkDetail: null,
    xplaneVersion: '12.4.3',
    apiVersion: 'v3',
    values: all,
    available: new Set(Object.keys(all) as TelemetryKey[]),
    lastContactAt: 1_000_000,
    ...extra,
  };
}

/** Live values at capture time: climbing through FL165, CRZ FL350, 548 NM to go. */
const CLIMB = { tlDistDest: 548.4, tlDestIcao: 'VIDP', tlCruiseAlt: 35000, tlFmgsPhase: 2, altitudeFt: 16500, vsFpm: 2000 };

describe('ToLiss MCDU mirror', () => {
  it('merges the colour layers of MCDU1 (F-PLN) into a 14 × 24 screen', () => {
    const s = tolissScreen(MCDU_CAPTURE, 1)!;
    expect(s.side).toBe('L');
    expect(s.lines).toHaveLength(14);
    expect(s.lines.every((l) => l.length === 24)).toBe(true);
    expect(s.lines[0]).toBe(' FROM          6488   ↑↓');
    expect(s.lines[3]).toBe(' ALBA2B BRG007°  11NM   ');
    expect(s.lines[8]).toBe('(T/C)   1610   " / FL350');
    expect(s.lines[11]).toBe('DEST    UTC   DIST  EFOB');
    expect(s.lines[12]).toBe('VIDP11L 1722   548   3.0');
    // (T/C) is large green, its time/alt small green
    expect(s.colors![8]!.slice(0, 5)).toBe('33333');
    expect(s.sizes![8]!.slice(0, 5)).toBe('11111');
    expect(s.sizes![8]![8]).toBe('2');
    // label rows are small (every non-space character)
    expect([...s.lines[3]!].every((c, i) => c === ' ' || s.sizes![3]![i] === '2')).toBe(true);
    expect(s.isProgress).toBe(true);
    expect(s.badge).toBe('F-PLN');
  });

  it('maps colours and the special-symbol layer on MCDU2 (PROG)', () => {
    const s = tolissScreen(MCDU_CAPTURE, 2)!;
    expect(s.side).toBe('R');
    expect(s.lines[0]).toBe('   CLIMB         6488   ');
    expect(s.lines[2]).toBe('FL350    FL359    FL373 ');
    expect(s.colors![2]!.slice(0, 5)).toBe('44444'); // FL350 cyan (blue layer)
    expect(s.colors![2]!.slice(9, 14)).toBe('33333'); // FL359 green
    expect(s.colors![2]!.slice(18, 23)).toBe('22222'); // FL373 magenta
    expect(s.lines[6]).toBe('*[    ]                 ');
    expect(s.lines[8]).toBe(' ---° /----.- TO [     ]');
    expect(s.isProgress).toBe(false);
    expect(s.badge).toBeNull();
  });

  it('returns only the MCDUs the aircraft publishes', () => {
    expect(tolissScreens({}).length).toBe(0);
    const only2 = Object.fromEntries(Object.entries(MCDU_CAPTURE).filter(([k]) => k.startsWith('tl2_')));
    expect(tolissScreens(only2).map((s) => s.side)).toEqual(['R']);
  });

  it('reads the F-PLN DEST line, but no UTC ETA before takeoff (TIME column)', () => {
    expect(findFplnDest(MCDU_CAPTURE)).toEqual({ icao: 'VIDP', etaZulu: '1722', distNm: 548, side: 'L' });
    const pre = tolissScreen(MCDU_CAPTURE, 1)!.lines.map((l) => l.replace('DEST    UTC ', 'DEST    TIME'));
    expect(parseFplnDest(pre)).toEqual({ icao: 'VIDP', etaZulu: null, distNm: 548 });
    expect(parseFplnDest(tolissScreen(MCDU_CAPTURE, 2)!.lines)).toBeNull();
  });
});

describe('ToLiss T/D and destination ETA', () => {
  it('detects the ToLiss profile and mirrors both MCDUs', () => {
    const s = status({ ...CLIMB, ...MCDU_CAPTURE });
    expect(detectProfile(s)).toBe('toliss');
    const m = buildCduMirror(s);
    expect(m?.aircraft).toBe('toliss');
    expect(m?.screens.map((x) => x.side)).toEqual(['L', 'R']);
    expect(buildPublicState(s, { ok: true, reason: null, mode: 'on_off' }, null, 1_000_000, 3000).profile).toBe('toliss');
  });

  it('estimates T/D from distance to destination and CRZ FL, already during the climb', () => {
    // 548.4 − (35 × 3 + 10) = 433.4
    expect(interpretTod(status(CLIMB))).toMatchObject({
      status: 'ahead',
      distanceNm: 433,
      estimated: true,
      source: 'AirbusFBW/DistToDest + toliss_airbus/init/cruise_alt',
      detail: expect.stringContaining('CRZ FL350'),
    });
  });

  it('uses the current altitude when it is above CRZ FL or CRZ FL is not set', () => {
    expect(interpretTod(status({ ...CLIMB, tlFmgsPhase: 3, altitudeFt: 37000 })).distanceNm).toBe(427);
    expect(interpretTod(status({ ...CLIMB, tlCruiseAlt: 0, altitudeFt: 30000 }))).toMatchObject({
      distanceNm: 448,
      source: 'AirbusFBW/DistToDest + altitude_ft_pilot',
    });
  });

  it('says T/D is due when the estimate reaches zero in cruise', () => {
    expect(interpretTod(status({ ...CLIMB, tlFmgsPhase: 3, tlDistDest: 100, altitudeFt: 35000 }))).toMatchObject({
      status: 'ahead',
      distanceNm: 0,
      detail: expect.stringMatching(/due/),
    });
  });

  it('reports passed from the FMGS phase (descent, approach, go-around, done)', () => {
    for (const phase of [4, 5, 6, 7]) {
      expect(interpretTod(status({ ...CLIMB, tlFmgsPhase: phase, tlDistDest: 90 }))).toMatchObject({
        status: 'passed',
        source: 'AirbusFBW/APPhase',
      });
    }
    expect(interpretTod(status({ ...CLIMB, tlFmgsPhase: 4 })).detail).toBe('FMGS phase DESCENT: past T/D.');
  });

  it('falls back to altitude history when the phase dataref is missing', () => {
    const { tlFmgsPhase: _p, ...noPhase } = CLIMB;
    const s = status({ ...noPhase, tlDistDest: 90, altitudeFt: 24000, vsFpm: 0 });
    expect(interpretTod(s, { peakAltitudeFt: 35000 }).status).toBe('passed');
    // still climbing towards CRZ FL: not passed
    expect(interpretTod(status({ ...noPhase, altitudeFt: 16500 }), { peakAltitudeFt: 16600 }).status).toBe('ahead');
  });

  it('reports no T/D without a flight plan', () => {
    expect(interpretTod(status({ ...CLIMB, tlDistDest: 0 })).status).toBe('no_td');
    expect(interpretDest(status({ ...CLIMB, tlDistDest: 0 }), 0).available).toBe(false);
  });

  it('computes live ETA always, and the FMS ETA when an MCDU shows F-PLN', () => {
    const zulu = 15 * 3600 + 59 * 60; // 1559Z
    const s = status({ ...CLIMB, ...MCDU_CAPTURE, groundspeedMs: 400 * KT, zuluTimeSec: zulu });
    const d = interpretDest(s, 1_000_000);
    expect(d).toMatchObject({
      available: true,
      icao: 'VIDP',
      distanceNm: 548.4,
      fmcEtaZulu: '1722',
      fmcEtaMinutes: 83,
      source: 'AirbusFBW/DistToDest · MCDU1 F-PLN DEST UTC',
    });
    expect(d.liveEtaMinutes).toBeCloseTo((548.4 / 400) * 60, 1);

    const noFpln = interpretDest(status({ ...CLIMB, groundspeedMs: 400 * KT, zuluTimeSec: zulu }), 0);
    expect(noFpln).toMatchObject({ available: true, icao: 'VIDP', fmcEtaZulu: null, source: 'AirbusFBW/DistToDest' });
  });

  it('lets the ICAO decide if datarefs of several aircraft are present', () => {
    const mixed = status({ ...CLIMB, ziboTdDist: 40, ziboTdIdx: 3 });
    expect(detectProfile(mixed)).toBe('toliss');
    expect(detectProfile({ ...mixed, values: { ...mixed.values, acfIcao: 'B738' } })).toBe('zibo737');
  });
});

// MCDU2 on PROG → REPORT, captured live 2026-11-23 (climbing through 5,700 ft
// out of VABB, CRZ FL350, DistToDest 631.8 NM, sim clock 12:01:27Z).
const REPORT_MCDU2: SimStatus['values'] = {
  tl2_titlew: '      REPORT 6488',
  tl2_label1w: ' OVHD          UTC  ALT',
  tl2_cont1g: 'VABB27        1158    30',
  tl2_label2w: ' TO',
  tl2_cont2g: 'ANOLI         1202 FL095',
  tl2_label3w: ' NEXT',
  tl2_cont3g: 'MB361         1210 FL240',
  tl2_label4w: ' SAT     T.WIND     FOB',
  tl2_cont4g: '+17`    056`/013     6.9',
  tl2_label5w: ' T/D      UTC DIST',
  tl2_cont5w: 'AT ',
  tl2_cont5g: '   FL350 1309  507',
  tl2_label6w: ' DEST     UTC DIST  EFOB',
  tl2_cont6w: 'VIDP11L  1334  632   3.2',
};
const REPORT_TIME = { tlDistDest: 631.8, tlDestIcao: 'VIDP', tlCruiseAlt: 35000, tlFmgsPhase: 2, altitudeFt: 5717, vsFpm: 2729, zuluTimeSec: 43287.4 };

describe('ToLiss FMS T/D from PROG → REPORT', () => {
  it('reads T/D time, distance and level by column from the captured page', () => {
    const lines = tolissScreen(REPORT_MCDU2, 2)!.lines;
    expect(lines[9]).toBe(' T/D      UTC DIST      ');
    expect(lines[10]).toBe('AT FL350 1309  507      ');
    expect(parseTdLine(lines)).toEqual({ etaZulu: '1309', distNm: 507, level: 'FL350' });
  });

  it('copes with shifted spacing and with no figures yet', () => {
    const TITLE = '      REPORT 6488';
    expect(parseTdLine([TITLE, ' T/D      UTC DIST', 'AT FL350 1309 1507'])).toMatchObject({ etaZulu: '1309', distNm: 1507 });
    expect(parseTdLine([TITLE, ' T/D      UTC DIST', 'AT FL350 0905   12'])).toMatchObject({ etaZulu: '0905', distNm: 12 });
    expect(parseTdLine([TITLE, ' T/D      UTC DIST', '         ----  ---'])).toMatchObject({ etaZulu: null, distNm: null });
    expect(parseTdLine([TITLE, ' TO                     ', 'ANOLI         1202 FL095'])).toBeNull();
  });

  it('uses the FMS figures, not the estimate, while an MCDU shows the T/D line', () => {
    // MCDU1 still on F-PLN (from the first capture), MCDU2 on REPORT.
    const mcdu1 = Object.fromEntries(Object.entries(MCDU_CAPTURE).filter(([k]) => k.startsWith('tl1_')));
    const s = status({ ...REPORT_TIME, ...mcdu1, ...REPORT_MCDU2 });
    expect(interpretTod(s)).toEqual({
      status: 'ahead',
      distanceNm: 507,
      detail: 'along route // toliss fms (PROG REPORT T/D AT FL350)',
      source: 'AirbusFBW/MCDU2 · PROG REPORT T/D',
      fmcEtaZulu: '1309',
      fmcEtaMinutes: 68,
    });
    expect(findTd(s.values)?.side).toBe('R');
    const mirror = buildCduMirror(s)!;
    expect(mirror.screens.find((x) => x.side === 'R')?.badge).toBe('T/D');
    expect(mirror.screens.find((x) => x.side === 'L')?.badge).toBe('F-PLN');
  });

  it('falls back to the estimate when the page is closed, and still reports passed from the FMGS phase', () => {
    const closed = status(REPORT_TIME);
    expect(interpretTod(closed)).toMatchObject({ status: 'ahead', estimated: true, distanceNm: 517 }); // 631.8 − 115
    expect(interpretTod(status({ ...REPORT_TIME, ...REPORT_MCDU2, tlFmgsPhase: 4 })).status).toBe('passed');
  });
});

// MCDU1 on PERF CRZ, captured live 2026-11-23 (climbing through FL254, sim
// clock 12:08:26Z); MCDU2 on REPORT at the same moment showed 1302Z / 415 NM.
const PERF_CRZ_MCDU1: SimStatus['values'] = {
  tl1_titlew: '           CRZ',
  tl1_label1w: 'ACT MODE   UTC DEST EFOB',
  tl1_cont1g: 'MANAGED   1327       3.2',
  tl1_label2w: ' CI',
  tl1_cont2g: '                   (T/D)',
  tl1_cont2b: '12',
  tl1_scont2w: '                TO',
  tl1_label3w: ' MANAGED   UTC      DIST',
  tl1_cont3g: '          1302       416',
  tl1_scont3g: ' 267/.78',
  tl1_label4w: ' PRESEL',
  tl1_cont4b: '*',
  tl1_cont4s: ' A B',
  tl1_label6w: ' PREV              NEXT',
  tl1_cont6w: '<PHASE            PHASE>',
};

describe('ToLiss FMS T/D from PERF CRZ', () => {
  it('reads the "TO (T/D)" block by column', () => {
    const lines = tolissScreen(PERF_CRZ_MCDU1, 1)!.lines;
    expect(lines[4]).toBe('12              TO (T/D)');
    expect(lines[5]).toBe(' MANAGED   UTC      DIST');
    expect(lines[6]).toBe(' 267/.78  1302       416');
    // no level on this page: "1302" is the time, not a level
    expect(parseTdLine(lines)).toEqual({ etaZulu: '1302', distNm: 416, level: null });
  });

  it('does not mistake the ACT MODE / DEST line or other "TO" markers for T/D', () => {
    const lines = tolissScreen(PERF_CRZ_MCDU1, 1)!.lines;
    expect(parseTdLine(lines.slice(0, 4))).toBeNull();
    const ed = lines.map((l) => l.replace('TO (T/D)', 'TO (E/D)'));
    expect(parseTdLine(ed)).toBeNull();
  });

  it('uses PERF CRZ for the T/D card and labels the page', () => {
    const s = status({ ...REPORT_TIME, zuluTimeSec: 43706.3, ...PERF_CRZ_MCDU1 });
    expect(interpretTod(s)).toEqual({
      status: 'ahead',
      distanceNm: 416,
      detail: 'along route // toliss fms (PERF CRZ T/D)',
      source: 'AirbusFBW/MCDU1 · PERF CRZ T/D',
      fmcEtaZulu: '1302',
      fmcEtaMinutes: 54,
    });
    expect(buildCduMirror(s)!.screens[0]!.badge).toBe('T/D');
  });
});
