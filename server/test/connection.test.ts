import { afterEach, describe, expect, it } from 'vitest';
import { XPlaneConnection } from '../src/xplane/connection.js';
import { TOLISS_MCDU_FIELDS } from '../src/xplane/datarefs.js';
import { PauseController } from '../src/xplane/pauseController.js';
import { buildCduMirror, buildTelemetry, detectProfile, interpretDest, interpretTod } from '../src/telemetry.js';
import { FakeXPlane, closedPort, waitFor, type FakeOptions } from './fakeXPlane.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  opts: FakeOptions = {},
  connOpts: Partial<ConstructorParameters<typeof XPlaneConnection>[0]> = {},
  mutate?: (fake: FakeXPlane) => void,
) {
  const fake = await new FakeXPlane(opts).listen();
  cleanups.push(() => fake.close());
  mutate?.(fake);
  const conn = new XPlaneConnection({
    baseUrl: fake.url,
    requestTimeoutMs: 500,
    pauseCommandMode: 'auto',
    initialBackoffMs: 50,
    maxBackoffMs: 200,
    noFlightRetryMs: 50,
    heartbeatMs: 100,
    ...connOpts,
  });
  cleanups.push(() => conn.stop());
  conn.start();
  return { fake, conn };
}

describe('XPlaneConnection against a fake X-Plane Web API', () => {
  it('discovers datarefs by name, subscribes and streams telemetry', async () => {
    const { conn } = await setup();
    await waitFor(() => conn.status().link === 'connected');
    await waitFor(() => conn.status().values.altitudeFt !== undefined);
    const s = conn.status();
    expect(s.xplaneVersion).toBe('12.4.3');
    expect(s.apiVersion).toBe('v3');
    const t = buildTelemetry(s, Date.now(), 3000);
    expect(t.fresh).toBe(true);
    expect(t.altitudeFt).toBe(35000);
    expect(t.groundspeedKt).toBeCloseTo(447.1, 1);
    expect(t.aircraftIcao).toBe('B738');
    expect(t.aircraftName).toBe('Boeing 737-800X');
    expect(conn.pauseCapability()).toEqual({ ok: true, reason: null, mode: 'on_off' });
  });

  it('pauses and resumes end-to-end using the idempotent on/off commands', async () => {
    const { fake, conn } = await setup();
    await waitFor(() => conn.status().link === 'connected');
    const pc = new PauseController(conn, { confirmTimeoutMs: 1500, pollIntervalMs: 20 });
    expect(await pc.request('pause')).toMatchObject({ ok: true, result: 'changed', paused: true });
    expect(await pc.request('pause')).toMatchObject({ ok: true, result: 'already' });
    expect(await pc.request('resume')).toMatchObject({ ok: true, result: 'changed', paused: false });
    expect(fake.activations).toEqual(['sim/operation/pause_on', 'sim/operation/pause_off']);
  });

  it('falls back to the toggle command when on/off are not available', async () => {
    const { fake, conn } = await setup({ onOffCommands: false });
    await waitFor(() => conn.status().link === 'connected');
    expect(conn.pauseCapability().mode).toBe('toggle');
    const pc = new PauseController(conn, { confirmTimeoutMs: 1500, pollIntervalMs: 20 });
    expect(await pc.request('pause')).toMatchObject({ ok: true, result: 'changed', paused: true });
    expect(await pc.request('resume')).toMatchObject({ ok: true, result: 'changed', paused: false });
    expect(fake.activations).toEqual(['sim/operation/pause_toggle', 'sim/operation/pause_toggle']);
  });

  it('honours PAUSE_COMMAND_MODE=toggle', async () => {
    const { conn } = await setup({}, { pauseCommandMode: 'toggle' });
    await waitFor(() => conn.status().link === 'connected');
    expect(conn.pauseCapability().mode).toBe('toggle');
  });

  it('reports unconfirmed when X-Plane accepts the command but does not change state', async () => {
    const { conn } = await setup({ commandBehavior: 'ignore' });
    await waitFor(() => conn.status().link === 'connected');
    const pc = new PauseController(conn, { confirmTimeoutMs: 300, pollIntervalMs: 20 });
    expect(await pc.request('pause')).toMatchObject({ ok: false, error: 'unconfirmed', paused: false });
  });

  it('reports command_failed when X-Plane rejects the activation', async () => {
    const { conn } = await setup({ commandBehavior: 'error' });
    await waitFor(() => conn.status().link === 'connected');
    const pc = new PauseController(conn, { confirmTimeoutMs: 300, pollIntervalMs: 20 });
    expect(await pc.request('pause')).toMatchObject({ ok: false, error: 'command_failed' });
  });

  it('reports disconnected when X-Plane is not running, then connects once it starts', async () => {
    const port = await closedPort();
    const conn = new XPlaneConnection({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      requestTimeoutMs: 300,
      pauseCommandMode: 'auto',
      initialBackoffMs: 50,
      maxBackoffMs: 100,
    });
    cleanups.push(() => conn.stop());
    conn.start();
    await waitFor(() => conn.status().link === 'disconnected' && /not running/.test(conn.status().linkDetail ?? ''));
    expect(conn.pauseCapability().ok).toBe(false);
    const pc = new PauseController(conn, { confirmTimeoutMs: 300 });
    expect(await pc.request('pause')).toMatchObject({ ok: false, error: 'unavailable' });

    const fake = await new FakeXPlane().listen(port);
    cleanups.push(() => fake.close());
    await waitFor(() => conn.status().link === 'connected', 5000);
  });

  it('reconnects after X-Plane drops the WebSocket', async () => {
    const { fake, conn } = await setup();
    await waitFor(() => conn.status().link === 'connected');
    fake.dropSockets();
    await waitFor(() => conn.status().link !== 'connected');
    await waitFor(() => conn.status().link === 'connected', 5000);
  });

  it('reports no_flight when X-Plane is up but exposes no datarefs', async () => {
    const { conn } = await setup({ noFlight: true });
    await waitFor(() => conn.status().link === 'no_flight');
    expect(conn.pauseCapability().ok).toBe(false);
  });

  it('disables control on Web API v1 (no command activation before 12.1.4)', async () => {
    const { conn } = await setup({ versions: ['v1'] });
    await waitFor(() => conn.status().link === 'connected');
    expect(conn.status().apiVersion).toBe('v1');
    expect(conn.pauseCapability()).toMatchObject({ ok: false, reason: expect.stringMatching(/12\.1\.4/) });
  });

  it('times out and refuses to act when X-Plane stops answering', async () => {
    const { fake, conn } = await setup();
    await waitFor(() => conn.status().link === 'connected');
    fake.opts.hangValueReads = true;
    const pc = new PauseController(conn, { confirmTimeoutMs: 300 });
    const res = await pc.request('pause');
    expect(res).toMatchObject({ ok: false, error: 'read_failed' });
    expect(fake.activations).toEqual([]);
    // Heartbeat failures end the session.
    await waitFor(() => conn.status().link !== 'connected', 5000);
  });

  it('picks up Zibo T/D datarefs and reads the distance', async () => {
    const { conn } = await setup({
      extraDatarefs: [
        { name: 'laminar/B738/fms/vnav_td_dist', value_type: 'double', value: 87.34 },
        { name: 'laminar/B738/fms/vnav_td_idx', value_type: 'double', value: 6 },
        { name: 'laminar/B738/FMS/flight_phase', value_type: 'double', value: 2 },
      ],
    });
    await waitFor(() => conn.status().values.ziboTdDist !== undefined);
    expect(interpretTod(conn.status())).toMatchObject({ status: 'ahead', distanceNm: 87.3 });
  });

  it('reads the Zibo destination, route distance and FMC ETA (string datarefs)', async () => {
    const { conn } = await setup({
      extraDatarefs: [
        { name: 'laminar/B738/FMS/dist_dest', value_type: 'double', value: 230.4 },
        { name: 'laminar/B738/FMS/time_dest', value_type: 'data', value: Buffer.from('1452\0').toString('base64') },
        { name: 'laminar/B738/fms/dest_icao', value_type: 'data', value: Buffer.from('VIDP\0\0').toString('base64') },
        { name: 'sim/time/zulu_time_sec', value_type: 'float', value: 14 * 3600 + 22 * 60 },
      ],
    });
    await waitFor(() => conn.status().values.ziboDestEta !== undefined && conn.status().values.zuluTimeSec !== undefined);
    const d = interpretDest(conn.status(), Date.now());
    expect(d).toMatchObject({ available: true, icao: 'VIDP', distanceNm: 230.4, fmcEtaZulu: '1452', fmcEtaMinutes: 30 });
    // fake GS is 230 m/s ≈ 447 kt → ≈ 31 min
    expect(d.liveEtaMinutes).toBeCloseTo((230.4 / (230 * 1.9438444924406)) * 60, 0);
  });

  const b64 = (t: string) => Buffer.from(`${t}\0\0`, 'latin1').toString('base64');
  /** Every ToLiss MCDU layer dataref, like the real aircraft: mostly empty, a few with text on MCDU1. */
  const tolissDatarefs = (text: Record<string, string>, omit: readonly string[] = []) => [
    { name: 'AirbusFBW/DistToDest', value_type: 'float', value: 548.4 },
    { name: 'toliss_airbus/flightplan/destination_icao', value_type: 'data', value: b64('VIDP') },
    { name: 'toliss_airbus/init/cruise_alt', value_type: 'float', value: 35000 },
    { name: 'AirbusFBW/APPhase', value_type: 'int', value: 2 },
    ...[1, 2].flatMap((n) =>
      TOLISS_MCDU_FIELDS.filter((f) => !omit.includes(`${n}${f}`)).map((f) => ({
        name: `AirbusFBW/MCDU${n}${f}`,
        value_type: 'data',
        value: b64(n === 1 ? (text[f] ?? '') : ''),
      })),
    ),
  ];

  it('streams ToLiss FMS datarefs and MCDU layer lines (leading spaces kept)', async () => {
    const { fake, conn } = await setup({
      extraDatarefs: tolissDatarefs({
        titlew: ' FROM          6488',
        label6w: 'DEST    UTC   DIST  EFOB',
        cont6w: 'VIDP11L 1722   548   3.0',
        scont4g: '        1610   " / FL350',
      }),
    });
    await waitFor(() => typeof conn.status().values.tl1_scont4g === 'string' && conn.status().values.tlFmgsPhase !== undefined);
    const st = conn.status();
    expect(st.values.tl1_scont4g).toBe('        1610   " / FL350');
    expect(st.values.tlDestIcao).toBe('VIDP');
    expect(detectProfile(st)).toBe('toliss');
    expect(interpretTod(st)).toMatchObject({ status: 'ahead', estimated: true, distanceNm: 433 });
    expect(interpretDest(st, Date.now())).toMatchObject({ icao: 'VIDP', fmcEtaZulu: '1722' });
    expect(buildCduMirror(st)?.screens[0]?.lines[12]).toBe('VIDP11L 1722   548   3.0');
    // Discovery is one batch per dataref family (6), even though X-Plane 404s
    // a batch with any unknown name and the Zibo/FF777 families are absent.
    expect(fake.datarefQueries.length).toBeLessThanOrEqual(8);
  });

  it('copes with an add-on version missing a few MCDU datarefs in a few requests, then caches it', async () => {
    const { fake, conn } = await setup(
      { extraDatarefs: tolissDatarefs({ cont6w: 'VIDP11L 1722   548   3.0' }, ['1spa', '2spa', '2scont6s']) },
      { resolveIntervalMs: 150 },
    );
    await waitFor(() => conn.status().values.tl1_cont6w === 'VIDP11L 1722   548   3.0');
    // 6 families + one retry per missing name + one probe check
    expect(fake.datarefQueries.length).toBeLessThanOrEqual(6 + 3 + 1 + 2);
    expect(conn.status().available.has('tl1_spw')).toBe(true);
    expect(conn.status().available.has('tl1_spa')).toBe(false);
    // Periodic refreshes reuse the known-missing names: one batch per family, MCDU lines in one request.
    const before = fake.datarefQueries.length;
    await new Promise((r) => setTimeout(r, 500));
    const after = fake.datarefQueries.slice(before);
    const refreshes = after.filter((n) => n > 200).length;
    expect(refreshes).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeLessThanOrEqual(refreshes * 6 + 6);
  });

  it('streams FlightFactor 777 CDU screens (data + int_array) and reads PROGRESS', async () => {
    const lines = [
      '  UAE1234 PROGRESS  1/2 ', ' TO      DTG  ETA   FUEL', 'FS817     12 1356Z   8.0', ' NEXT                   ',
      'DP502     25 1359Z   7.7', ' DEST                   ', 'VIDP      60 1409Z   7.3', ' TGT SPD          TO E/D',
      '250         1409Z/  58NM', '                        ', '                        ', '------------------------',
      '<POS REPORT     POS REF>', '                        ',
    ];
    const screen = Buffer.concat([Buffer.from(lines.join(''), 'latin1'), Buffer.from([0])]).toString('base64');
    const colors = Array<number>(336).fill(1).map((c, i) => (i < 24 ? 4 : c));
    const { conn } = await setup({
      extraDatarefs: [
        { name: '1-sim/cduL/display/numOfLines', value_type: 'int', value: 14 },
        { name: '1-sim/cduL/display/numOfSymbolsInLine', value_type: 'int', value: 24 },
        { name: '1-sim/cduR/display/symbols', value_type: 'data', value: screen },
        { name: '1-sim/cduR/display/symbolsColor', value_type: 'int_array', value: colors },
        { name: '1-sim/cduR/display/symbolsSize', value_type: 'int_array', value: Array<number>(336).fill(1) },
      ],
    });
    await waitFor(() => Array.isArray(conn.status().values.ffCduRColor) && typeof conn.status().values.ffCduR === 'string');
    const st = conn.status();
    expect(detectProfile(st)).toBe('ff777');
    // fake altitude 35000 ft, 60 NM out, after cruising at FL390 → descending, T/D passed
    expect(interpretTod(st, { peakAltitudeFt: 39000 })).toMatchObject({
      status: 'passed',
      source: '1-sim/cduR/display/symbols · PROGRESS 1 DEST + altitude_ft_pilot',
    });
    expect(interpretDest(st, Date.now())).toMatchObject({ available: true, icao: 'VIDP', distanceNm: 60, fmcEtaZulu: '1409' });
    const mirror = buildCduMirror(st);
    expect(mirror?.screens[0]?.lines[0]).toBe('  UAE1234 PROGRESS  1/2 ');
    expect(mirror?.screens[0]?.colors?.[0]).toBe('4'.repeat(24));
  });

  it('ignores datarefs whose type does not match (no garbage telemetry)', async () => {
    const { conn } = await setup({}, {}, (fake) => {
      fake.datarefs.find((d) => d.name === 'sim/cockpit2/gauges/indicators/altitude_ft_pilot')!.value_type = 'float_array';
    });
    await waitFor(() => conn.status().link === 'connected');
    await waitFor(() => conn.status().values.groundspeedMs !== undefined);
    expect(conn.status().available.has('altitudeFt')).toBe(false);
    expect(conn.status().values.altitudeFt).toBeUndefined();
  });

  it('reports T/D unavailable for a non-Zibo aircraft', async () => {
    const { conn } = await setup();
    await waitFor(() => conn.status().link === 'connected');
    expect(interpretTod(conn.status()).status).toBe('unavailable');
  });
});
