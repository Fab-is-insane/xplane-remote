// State-aware pause / resume.
//
//   read sim/time/paused  →  already in target state? → report "already", send nothing
//                         →  otherwise activate the pause command
//   poll sim/time/paused until it shows the target state or the timeout expires
//   success is reported ONLY when X-Plane itself reports the target state.
//
// Concurrency: one operation at a time. A duplicate request for the same
// action joins the running one (so a double-tap cannot issue two toggles);
// a request for the opposite action while one is running is rejected (busy).

import type { PauseAction, PauseResponse } from '../shared/api-types.js';
import type { Logger, SimSource } from './simSource.js';
import { silentLogger } from './simSource.js';

export interface PauseControllerOptions {
  confirmTimeoutMs: number;
  pollIntervalMs?: number;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class PauseController {
  private running: { action: PauseAction; promise: Promise<PauseResponse> } | null = null;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly sim: SimSource,
    private readonly opts: PauseControllerOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 150;
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  inFlight(): PauseAction | null {
    return this.running?.action ?? null;
  }

  request(action: PauseAction): Promise<PauseResponse> {
    if (this.running) {
      if (this.running.action === action) return this.running.promise;
      return Promise.resolve({
        ok: false,
        action,
        error: 'busy',
        message: `A ${this.running.action} request is still being confirmed. Try again in a moment.`,
        paused: this.lastKnownPaused(),
      });
    }
    const promise = this.execute(action).finally(() => {
      this.running = null;
    });
    this.running = { action, promise };
    return promise;
  }

  private async execute(action: PauseAction): Promise<PauseResponse> {
    const target = action === 'pause';
    const started = this.now();

    const cap = this.sim.pauseCapability();
    if (!cap.ok) {
      return { ok: false, action, error: 'unavailable', message: cap.reason ?? 'Pause control is unavailable.', paused: this.lastKnownPaused() };
    }

    let before: boolean;
    try {
      before = await this.sim.readPaused();
    } catch (err) {
      return {
        ok: false,
        action,
        error: 'read_failed',
        message: `Could not read the simulator's pause state, so no command was sent. (${errMsg(err)})`,
        paused: null,
      };
    }

    if (before === target) {
      return { ok: true, action, result: 'already', paused: before, confirmedAt: this.now(), elapsedMs: this.now() - started, command: null };
    }

    let command: string;
    try {
      command = await this.sim.sendPauseCommand(target);
    } catch (err) {
      this.log.warn(`${action}: command failed: ${errMsg(err)}`);
      return { ok: false, action, error: 'command_failed', message: `X-Plane did not accept the command. (${errMsg(err)})`, paused: before };
    }

    const deadline = started + this.opts.confirmTimeoutMs;
    let last: boolean | null = before;
    while (this.now() < deadline) {
      await this.sleep(this.pollIntervalMs);
      try {
        last = await this.sim.readPaused();
      } catch {
        last = null; // keep polling until the deadline
        continue;
      }
      if (last === target) {
        const t = this.now();
        this.log.info(`${action}: confirmed paused=${last} after ${t - started} ms via ${command}`);
        return { ok: true, action, result: 'changed', paused: last, confirmedAt: t, elapsedMs: t - started, command };
      }
    }

    this.log.warn(`${action}: not confirmed within ${this.opts.confirmTimeoutMs} ms (last paused=${last})`);
    return {
      ok: false,
      action,
      error: 'unconfirmed',
      message:
        last === null
          ? `Command sent, but the simulator state could not be read back within ${this.opts.confirmTimeoutMs / 1000} s.`
          : `Command sent, but X-Plane still reports ${last ? 'PAUSED' : 'RUNNING'} after ${this.opts.confirmTimeoutMs / 1000} s.`,
      paused: last,
    };
  }

  private lastKnownPaused(): boolean | null {
    const v = this.sim.status().values.paused;
    return typeof v === 'number' ? v !== 0 : null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
