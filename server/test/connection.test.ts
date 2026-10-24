import { afterEach, describe, expect, it } from 'vitest';
import { XPlaneConnection } from '../src/xplane/connection.js';
import { PauseController } from '../src/xplane/pauseController.js';
import { buildTelemetry, interpretTod } from '../src/telemetry.js';
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
