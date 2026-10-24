import { describe, expect, it } from 'vitest';
import { buildTelemetry, interpretDest, interpretTod } from '../src/telemetry.js';
import type { TelemetryKey } from '../src/xplane/datarefs.js';
import type { SimStatus } from '../src/xplane/simSource.js';

function status(values: SimStatus['values'], extra: Partial<SimStatus> = {}): SimStatus {
  return {
    source: 'xplane',
    link: 'connected',
    linkDetail: null,
    xplaneVersion: '12.4.3',
    apiVersion: 'v3',
    values,
    available: new Set(Object.keys(values) as TelemetryKey[]),
    lastContactAt: 1_000_000,
    ...extra,
  };
}

describe('buildTelemetry', () => {
  it('converts units and labels values', () => {
    const t = buildTelemetry(
      status({ paused: 0, groundspeedMs: 100, elevationM: 1000, headingMag: -10, altitudeFt: 35000.4, vsFpm: -1500.2 }),
      1_000_500,
      3000,
    );
    expect(t.fresh).toBe(true);
    expect(t.paused).toBe(false);
    expect(t.groundspeedKt).toBeCloseTo(194.4, 1);
    expect(t.trueAltitudeFt).toBe(3281);
    expect(t.headingMagDeg).toBe(350);
    expect(t.altitudeFt).toBe(35000);
    expect(t.verticalSpeedFpm).toBe(-1500);
  });

  it('marks telemetry stale when X-Plane has not answered within the window', () => {
    const t = buildTelemetry(status({ paused: 1 }), 1_000_000 + 3001, 3000);
    expect(t.fresh).toBe(false);
    expect(t.ageMs).toBe(3001);
    expect(t.paused).toBe(true); // last known value is kept but flagged not fresh
  });

  it('is never fresh while disconnected, even with recent contact', () => {
    const t = buildTelemetry(status({ paused: 0 }, { link: 'disconnected' }), 1_000_100, 3000);
    expect(t.fresh).toBe(false);
  });

  it('reports missing telemetry as null rather than inventing values', () => {
    const t = buildTelemetry(status({}, { lastContactAt: null }), 1_000_000, 3000);
    expect(t.fresh).toBe(false);
    expect(t.lastUpdate).toBeNull();
    expect(t.altitudeFt).toBeNull();
    expect(t.groundspeedKt).toBeNull();
    expect(t.paused).toBeNull();
  });
});

describe('interpretTod (Zibo 737)', () => {
  it('is unavailable when the Zibo datarefs are not present', () => {
    expect(interpretTod(status({ paused: 0 })).status).toBe('unavailable');
  });

  it('reports no T/D when the FMC has none computed', () => {
    const r = interpretTod(status({ ziboTdDist: 0, ziboTdIdx: 0, ziboFlightPhase: 2 }));
    expect(r.status).toBe('no_td');
    expect(r.distanceNm).toBeNull();
  });

  it('reports calculating for the 9999 sentinel', () => {
    expect(interpretTod(status({ ziboTdDist: 9999, ziboTdIdx: 5, ziboFlightPhase: 2 })).status).toBe('calculating');
  });

  it('reports the along-track distance when T/D is ahead', () => {
    const r = interpretTod(status({ ziboTdDist: 123.456, ziboTdIdx: 5, ziboFlightPhase: 2 }));
    expect(r).toMatchObject({ status: 'ahead', distanceNm: 123.5, source: 'laminar/B738/fms/vnav_td_dist' });
  });

  it('reports passed when the distance is negative', () => {
    expect(interpretTod(status({ ziboTdDist: -3.2, ziboTdIdx: 5, ziboFlightPhase: 2 }))).toMatchObject({ status: 'passed', distanceNm: 3.2 });
  });

  it('reports passed in the descent phase regardless of the distance value', () => {
    expect(interpretTod(status({ ziboTdDist: 40, ziboTdIdx: 5, ziboFlightPhase: 5 })).status).toBe('passed');
  });

  it('waits for values when datarefs exist but nothing has been received yet', () => {
    const s = status({});
    s.available = new Set<TelemetryKey>(['ziboTdDist', 'ziboTdIdx']);
    expect(interpretTod(s).status).toBe('unavailable');
    expect(interpretTod(s).detail).toMatch(/Waiting/);
  });

  it('ignores non-numeric garbage', () => {
    const r = interpretTod(status({ ziboTdDist: 'abc' as unknown as number, ziboTdIdx: 5 }));
    expect(r.status).toBe('unavailable');
  });
});

describe('interpretDest (Zibo route + live telemetry)', () => {
  const NOW = 1_000_000;
  const KT = 1 / 1.9438444924406; // m/s per knot

  it('is unavailable without the Zibo destination datarefs', () => {
    expect(interpretDest(status({ groundspeedMs: 200 }), NOW).available).toBe(false);
  });

  it('is unavailable when the FMC has no route (distance 0)', () => {
    const r = interpretDest(status({ ziboDestDist: 0, ziboDestEta: '', groundspeedMs: 200 }), NOW);
    expect(r).toMatchObject({ available: false, detail: 'No route in the FMC.' });
  });

  it('computes the live ETA from route distance and ground speed', () => {
    const r = interpretDest(status({ ziboDestDist: 120, groundspeedMs: 240 * KT, ziboDestIcao: 'VIDP' }), NOW);
    expect(r.available).toBe(true);
    expect(r.icao).toBe('VIDP');
    expect(r.distanceNm).toBe(120);
    expect(r.liveEtaMinutes).toBeCloseTo(30, 1);
    expect(r.liveEtaAt).toBe(NOW + 30 * 60_000);
  });

  it('gives no live ETA below 60 kt (taxi / parked)', () => {
    const r = interpretDest(status({ ziboDestDist: 4, groundspeedMs: 10 * KT }), NOW);
    expect(r.available).toBe(true);
    expect(r.liveEtaMinutes).toBeNull();
    expect(r.liveEtaAt).toBeNull();
  });

  it('turns the FMC "HHMM" ETA into minutes by the sim Zulu clock', () => {
    const r = interpretDest(status({ ziboDestDist: 80, ziboDestEta: '1430', zuluTimeSec: 14 * 3600 + 5 * 60 }), NOW);
    expect(r).toMatchObject({ fmcEtaZulu: '1430', fmcEtaMinutes: 25 });
  });

  it('handles an FMC ETA after midnight', () => {
    const r = interpretDest(status({ ziboDestDist: 80, ziboDestEta: '0010', zuluTimeSec: 23 * 3600 + 50 * 60 }), NOW);
    expect(r.fmcEtaMinutes).toBe(20);
  });

  it('treats an FMC ETA just behind the clock as arriving now', () => {
    const r = interpretDest(status({ ziboDestDist: 2, ziboDestEta: '1429', zuluTimeSec: 14 * 3600 + 30 * 60 }), NOW);
    expect(r.fmcEtaMinutes).toBe(0);
  });

  it('ignores a malformed FMC ETA string', () => {
    const r = interpretDest(status({ ziboDestDist: 80, ziboDestEta: '----', zuluTimeSec: 100 }), NOW);
    expect(r).toMatchObject({ fmcEtaZulu: null, fmcEtaMinutes: null });
  });
});
