import { describe, expect, it } from 'vitest';
import { PauseController } from '../src/xplane/pauseController.js';
import type { PauseCapability, SimSource, SimStatus } from '../src/xplane/simSource.js';

/** In-memory SimSource whose behaviour each test scripts. */
class ScriptedSim implements SimSource {
  readonly source = 'xplane' as const;
  paused = false;
  commands: string[] = [];
  capability: PauseCapability = { ok: true, reason: null, mode: 'on_off' };
  readError: Error | null = null;
  commandError: Error | null = null;
  /** What the "simulator" does when it receives the command. */
  applyCommand: 'apply' | 'ignore' = 'apply';
  readDelayMs = 0;

  start() {}
  async stop() {}
  status(): SimStatus {
    return {
      source: 'xplane',
      link: 'connected',
      linkDetail: null,
      xplaneVersion: '12.4.3',
      apiVersion: 'v3',
      values: { paused: this.paused ? 1 : 0 },
      available: new Set(['paused']),
      lastContactAt: Date.now(),
    };
  }
  pauseCapability() {
    return this.capability;
  }
  async readPaused() {
    if (this.readDelayMs) await new Promise((r) => setTimeout(r, this.readDelayMs));
    if (this.readError) throw this.readError;
    return this.paused;
  }
  async sendPauseCommand(target: boolean) {
    if (this.commandError) throw this.commandError;
    const name = this.capability.mode === 'toggle' ? 'sim/operation/pause_toggle' : target ? 'sim/operation/pause_on' : 'sim/operation/pause_off';
    this.commands.push(name);
    if (this.applyCommand === 'apply') this.paused = name === 'sim/operation/pause_toggle' ? !this.paused : target;
    return name;
  }
  onChange() {
    return () => {};
  }
}

function controller(sim: SimSource, confirmTimeoutMs = 300) {
  return new PauseController(sim, { confirmTimeoutMs, pollIntervalMs: 10 });
}

describe('PauseController', () => {
  it('pauses a running simulator and confirms the new state', async () => {
    const sim = new ScriptedSim();
    const res = await controller(sim).request('pause');
    expect(res).toMatchObject({ ok: true, action: 'pause', result: 'changed', paused: true, command: 'sim/operation/pause_on' });
    expect(sim.commands).toEqual(['sim/operation/pause_on']);
  });

  it('does nothing when asked to pause an already paused simulator', async () => {
    const sim = new ScriptedSim();
    sim.paused = true;
    const res = await controller(sim).request('pause');
    expect(res).toMatchObject({ ok: true, result: 'already', paused: true, command: null });
    expect(sim.commands).toEqual([]);
  });

  it('resumes a paused simulator and confirms the new state', async () => {
    const sim = new ScriptedSim();
    sim.paused = true;
    const res = await controller(sim).request('resume');
    expect(res).toMatchObject({ ok: true, action: 'resume', result: 'changed', paused: false, command: 'sim/operation/pause_off' });
  });

  it('does nothing when asked to resume an already running simulator', async () => {
    const sim = new ScriptedSim();
    const res = await controller(sim).request('resume');
    expect(res).toMatchObject({ ok: true, result: 'already', paused: false });
    expect(sim.commands).toEqual([]);
  });

  it('uses the toggle only after checking the state (toggle mode)', async () => {
    const sim = new ScriptedSim();
    sim.capability = { ok: true, reason: null, mode: 'toggle' };
    const c = controller(sim);
    expect(await c.request('pause')).toMatchObject({ ok: true, result: 'changed', paused: true });
    expect(await c.request('pause')).toMatchObject({ ok: true, result: 'already', paused: true });
    expect(await c.request('resume')).toMatchObject({ ok: true, result: 'changed', paused: false });
    expect(sim.commands).toEqual(['sim/operation/pause_toggle', 'sim/operation/pause_toggle']);
  });

  it('reports unconfirmed when the command is accepted but the state never changes', async () => {
    const sim = new ScriptedSim();
    sim.applyCommand = 'ignore';
    const res = await controller(sim, 200).request('pause');
    expect(res).toMatchObject({ ok: false, error: 'unconfirmed', paused: false });
    expect(sim.commands).toHaveLength(1);
  });

  it('does not send a command when the current state cannot be read (timeout / disconnect)', async () => {
    const sim = new ScriptedSim();
    sim.readError = new Error('X-Plane did not answer within 2000 ms');
    const res = await controller(sim).request('pause');
    expect(res).toMatchObject({ ok: false, error: 'read_failed', paused: null });
    expect(sim.commands).toEqual([]);
  });

  it('reports command_failed when X-Plane rejects the command', async () => {
    const sim = new ScriptedSim();
    sim.commandError = new Error('X-Plane: boom');
    const res = await controller(sim).request('pause');
    expect(res).toMatchObject({ ok: false, error: 'command_failed', paused: false });
  });

  it('reports unconfirmed (state unknown) when read-back fails after the command', async () => {
    const sim = new ScriptedSim();
    sim.applyCommand = 'ignore';
    const c = controller(sim, 150);
    const p = c.request('pause');
    await new Promise((r) => setTimeout(r, 5));
    sim.readError = new Error('connection lost');
    expect(await p).toMatchObject({ ok: false, error: 'unconfirmed', paused: null });
  });

  it('refuses when control is unavailable (not connected / API too old)', async () => {
    const sim = new ScriptedSim();
    sim.capability = { ok: false, reason: 'Not connected to X-Plane', mode: null };
    const res = await controller(sim).request('resume');
    expect(res).toMatchObject({ ok: false, error: 'unavailable', message: 'Not connected to X-Plane' });
    expect(sim.commands).toEqual([]);
  });

  it('coalesces repeated presses of the same action into one command', async () => {
    const sim = new ScriptedSim();
    sim.readDelayMs = 20;
    const c = controller(sim);
    const [a, b, d] = await Promise.all([c.request('pause'), c.request('pause'), c.request('pause')]);
    expect(a).toBe(b);
    expect(b).toBe(d);
    expect(sim.commands).toEqual(['sim/operation/pause_on']);
  });

  it('rejects the opposite action while one is in flight', async () => {
    const sim = new ScriptedSim();
    sim.readDelayMs = 20;
    const c = controller(sim);
    const first = c.request('pause');
    expect(c.inFlight()).toBe('pause');
    const second = await c.request('resume');
    expect(second).toMatchObject({ ok: false, error: 'busy' });
    expect(await first).toMatchObject({ ok: true, result: 'changed' });
    expect(c.inFlight()).toBeNull();
    expect(sim.commands).toEqual(['sim/operation/pause_on']);
  });
});
