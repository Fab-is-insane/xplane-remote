import { describe, expect, it } from 'vitest';
import { cduScreens, findProgress, parseProgress } from '../src/aircraft/ff777.js';
import { FlightMemory, buildCduMirror, buildPublicState, detectProfile, interpretDest, interpretTod } from '../src/telemetry.js';
import type { TelemetryKey } from '../src/xplane/datarefs.js';
import type { SimStatus } from '../src/xplane/simSource.js';

// Screens captured from the live FF777 (2026-11-02, descent into VIDP).
const PROGRESS_DESCENT = [
  '  UAE1234 PROGRESS  1/2 ',
  ' TO      DTG  ETA   FUEL',
  'FS817     12 1356Z   8.0',
  ' NEXT                   ',
  'DP502     25 1359Z   7.7',
  ' DEST                   ',
  'VIDP      60 1409Z   7.3',
  ' TGT SPD          TO E/D',
  '250         1409Z/  58NM',
  '                        ',
  '                        ',
  '------------------------',
  '<POS REPORT     POS REF>',
  '                        ',
];

const ARRIVALS = [
  '   VIDP ARRIVALS    2/32',
  ' STARS   RTE 1APPROACHES',
  'APUD7F            ILS11R',
  '                        ',
  'APUD7G             ILS27',
  '                        ',
  'APUD7H             ILS28',
  '                        ',
  'APUD7L      <ACT> ILS29R',
  '                        ',
  'APUD7M             LOC09',
  '------------------------',
  '<INDEX            ROUTE>',
  '                        ',
];

/** Same page in cruise / climb: only the bottom label and figures differ. */
function progressWith(label: string, data: string, dest = 'VIDP     412 1530Z  31.2'): string[] {
  const p = [...PROGRESS_DESCENT];
  p[6] = dest.padEnd(24, ' ');
  p[7] = ` TGT SPD          ${label}`.padEnd(24, ' ').slice(0, 24);
  p[8] = data.padEnd(24, ' ').slice(0, 24);
  return p;
}

/** The dataref value as the server sees it after decoding: 14×24 chars + trailing NUL→space. */
const raw = (lines: string[]) => lines.join('') + ' ';

function status(values: SimStatus['values'], extra: Partial<SimStatus> = {}): SimStatus {
  return {
    source: 'xplane',
    link: 'connected',
    linkDetail: null,
    xplaneVersion: '12.4.3',
    apiVersion: 'v3',
    values: { ffCduLines: 14, ffCduCols: 24, acfIcao: 'B77W', ...values },
    available: new Set(['ffCduLines', 'ffCduCols', ...Object.keys(values)] as TelemetryKey[]),
    lastContactAt: 1_000_000,
    ...extra,
  };
}

describe('FF777 PROGRESS page parser', () => {
  it('reads DEST and TO E/D from the captured descent page', () => {
    expect(parseProgress(PROGRESS_DESCENT, 'R')).toEqual({
      side: 'R',
      dest: { icao: 'VIDP', dtgNm: 60, etaZulu: '1409' },
      next: { kind: 'E/D', etaZulu: '1409', distNm: 58 },
    });
  });

  it('reads TO T/D in cruise', () => {
    const r = parseProgress(progressWith('TO T/D', '310         1442Z/ 123NM'));
    expect(r?.next).toEqual({ kind: 'T/D', etaZulu: '1442', distNm: 123 });
    expect(r?.dest).toEqual({ icao: 'VIDP', dtgNm: 412, etaZulu: '1530' });
  });

  it('reads TO T/C in climb', () => {
    expect(parseProgress(progressWith('TO T/C', '250         1312Z/  41NM'))?.next?.kind).toBe('T/C');
  });

  it('copes with a DEST line that has no ETA yet', () => {
    const r = parseProgress(progressWith('TO T/D', '', 'VIDP     412'));
    expect(r?.dest).toEqual({ icao: 'VIDP', dtgNm: 412, etaZulu: null });
    expect(r?.next).toEqual({ kind: 'T/D', etaZulu: null, distNm: null });
  });

  it('ignores every other page', () => {
    expect(parseProgress(ARRIVALS)).toBeNull();
    expect(parseProgress(['  UAE1234 PROGRESS  2/2 ', ...PROGRESS_DESCENT.slice(1)])).toBeNull();
  });

  it('prefers the centre, then right, then left CDU', () => {
    const v = { ffCduL: raw(PROGRESS_DESCENT), ffCduR: raw(progressWith('TO T/D', '1442Z/ 123NM')), ffCduC: raw(ARRIVALS) };
    expect(findProgress(status(v).values)?.side).toBe('R');
    expect(findProgress(status({ ffCduL: raw(PROGRESS_DESCENT) }).values)?.side).toBe('L');
    expect(findProgress(status({ ffCduL: raw(ARRIVALS) }).values)).toBeNull();
  });

  it('builds mirror screens with colours and sizes, in L, C, R order', () => {
    const colors = Array<number>(336).fill(1);
    colors[0] = 3;
    const screens = cduScreens(
      status({ ffCduR: raw(PROGRESS_DESCENT), ffCduL: raw(ARRIVALS), ffCduLColor: colors, ffCduLSize: Array<number>(336).fill(2) }).values,
    );
    expect(screens.map((s) => s.side)).toEqual(['L', 'R']);
    expect(screens[0]!.lines).toHaveLength(14);
    expect(screens[0]!.lines[0]).toBe('   VIDP ARRIVALS    2/32');
    expect(screens[0]!.colors?.[0]).toBe('3' + '1'.repeat(23));
    expect(screens[0]!.sizes?.[5]).toBe('2'.repeat(24));
    expect(screens[1]!.colors).toBeNull();
    expect(screens[1]!.isProgress).toBe(true);
  });
});

describe('FF777 T/D and destination ETA', () => {
  const KT = 1 / 1.9438444924406;

  it('detects the FF777 profile from its CDU datarefs', () => {
    expect(detectProfile(status({ ffCduL: raw(ARRIVALS) }))).toBe('ff777');
    expect(detectProfile(status({}, { available: new Set<TelemetryKey>(['paused']) }))).toBe('generic');
  });

  it('asks for PROGRESS when no CDU shows it', () => {
    const s = status({ ffCduL: raw(ARRIVALS), groundspeedMs: 250 * KT });
    expect(interpretTod(s)).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/PROGRESS/) });
    expect(interpretDest(s, 0)).toMatchObject({ available: false, detail: expect.stringMatching(/PROGRESS/) });
  });

  it('reports T/D ahead with the FMC distance in cruise', () => {
    const s = status({ ffCduC: raw(progressWith('TO T/D', '310         1442Z/ 123NM')) });
    expect(interpretTod(s)).toEqual({
      status: 'ahead',
      distanceNm: 123,
      detail: 'along route // ff777 fmc (PROGRESS)',
      source: '1-sim/cduC/display/symbols · PROGRESS 1',
    });
  });

  it('reports climb while the FMC shows T/C', () => {
    expect(interpretTod(status({ ffCduC: raw(progressWith('TO T/C', '1312Z/  41NM')) })).status).toBe('climb');
  });

  // Captured live in cruise (2026-11-03): the FF777 shows STEP CLB, not T/D.
  const PROGRESS_CRUISE = progressWith('TO STEP CLB', '.838                NONE', 'VIDP    3893 2249Z  14.0');

  it('estimates T/D from DEST distance and altitude when the FMC shows no T/D (cruise)', () => {
    const s = status({ ffCduR: raw(PROGRESS_CRUISE), altitudeFt: 37000, vsFpm: -20 });
    // 3893 − (37 × 3 + 10) = 3772
    expect(interpretTod(s, { peakAltitudeFt: 37010 })).toMatchObject({
      status: 'ahead',
      distanceNm: 3772,
      estimated: true,
      source: '1-sim/cduR/display/symbols · PROGRESS 1 DEST + altitude_ft_pilot',
    });
  });

  it('treats TO E/D at cruise altitude as T/D still ahead (the FF777 shows E/D before T/D)', () => {
    const s = status({ ffCduC: raw(progressWith('TO E/D', '.838        2241Z/3880NM', 'VIDP     300 2249Z  14.0')), altitudeFt: 37000, vsFpm: 0 });
    expect(interpretTod(s, { peakAltitudeFt: 37000 })).toMatchObject({ status: 'ahead', distanceNm: 179, estimated: true });
  });

  it('says T/D is due when the estimate reaches zero while still level at cruise', () => {
    const s = status({ ffCduC: raw(progressWith('TO E/D', '', 'VIDP     115')), altitudeFt: 37000, vsFpm: 0 });
    expect(interpretTod(s, { peakAltitudeFt: 37000 })).toMatchObject({ status: 'ahead', distanceNm: 0, detail: expect.stringMatching(/due/) });
  });

  it('reports passed once the aircraft has left cruise altitude, even during a level-off', () => {
    const s = status({ ffCduC: raw(progressWith('TO E/D', '', 'VIDP      90')), altitudeFt: 24000, vsFpm: 0 });
    expect(interpretTod(s, { peakAltitudeFt: 37000 })).toMatchObject({ status: 'passed', detail: 'Descending from FL370: past T/D.' });
  });

  it('reports passed when descending near T/D with no flight history (e.g. after a server restart)', () => {
    const s = status({ ffCduC: raw(progressWith('TO E/D', '', 'VIDP     120')), altitudeFt: 35000, vsFpm: -2200 });
    expect(interpretTod(s).status).toBe('passed');
    // …but not a cruise step-down far from destination
    const far = status({ ffCduC: raw(progressWith('TO E/D', '', 'VIDP     900')), altitudeFt: 35000, vsFpm: -1000 });
    expect(interpretTod(far).status).toBe('ahead');
  });

  it('waits for altitude before estimating', () => {
    expect(interpretTod(status({ ffCduC: raw(PROGRESS_CRUISE) })).status).toBe('calculating');
  });

  it('reports T/D passed in descent, and computes both ETAs from the DEST line', () => {
    const s = status({ ffCduR: raw(PROGRESS_DESCENT), groundspeedMs: 240 * KT, zuluTimeSec: 13 * 3600 + 54 * 60, altitudeFt: 9000, vsFpm: -1500 });
    expect(interpretTod(s, { peakAltitudeFt: 39000 }).status).toBe('passed');
    const d = interpretDest(s, 1_000_000);
    expect(d).toMatchObject({
      available: true,
      icao: 'VIDP',
      distanceNm: 60,
      fmcEtaZulu: '1409',
      fmcEtaMinutes: 15,
      source: '1-sim/cduR/display/symbols · PROGRESS 1 DEST',
    });
    expect(d.liveEtaMinutes).toBeCloseTo(15, 1);
    expect(d.liveEtaAt).toBe(1_000_000 + 15 * 60_000);
  });

  it('includes the profile in the public state and mirrors the CDUs', () => {
    const s = status({ ffCduR: raw(PROGRESS_DESCENT) });
    const st = buildPublicState(s, { ok: true, reason: null, mode: 'on_off' }, null, 1_000_000, 3000);
    expect(st.profile).toBe('ff777');
    expect(buildCduMirror(s)?.screens[0]?.side).toBe('R');
  });

  it('remembers the highest altitude of the flight, and forgets it on the ground, new aircraft or relocation', () => {
    const m = new FlightMemory();
    const at = (altitudeFt: number, extra: SimStatus['values'] = {}) =>
      m.observe(status({ altitudeFt, groundspeedMs: 450 * KT, latitude: 25, longitude: 55, ...extra }));
    at(10000);
    at(37000);
    at(30000);
    expect(m.peakAltitudeFt).toBe(37000);
    at(30000, { groundspeedMs: 20 * KT });
    expect(m.peakAltitudeFt).toBeNull();
    at(35000);
    at(33000, { acfIcao: 'B738' });
    expect(m.peakAltitudeFt).toBe(33000);
    at(31000, { acfIcao: 'B738', latitude: 30 });
    expect(m.peakAltitudeFt).toBe(31000);
  });

  it('never mirrors CDUs for the Zibo', () => {
    const zibo: SimStatus = { ...status({}), values: { ziboTdDist: 40, ziboTdIdx: 3 }, available: new Set<TelemetryKey>(['ziboTdDist', 'ziboTdIdx']) };
    expect(detectProfile(zibo)).toBe('zibo737');
    expect(buildCduMirror(zibo)).toBeNull();
  });
});
