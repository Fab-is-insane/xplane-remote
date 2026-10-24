// DEVELOPMENT ONLY: a fake simulator so the UI can be built without X-Plane.
// Enabled only with XPLANE_MOCK=true or `--mock`. Every state it produces is
// tagged source: "mock" and the client shows a permanent "MOCK DATA" banner.

import { EventEmitter } from 'node:events';
import type { TelemetryKey } from './datarefs.js';
import { PAUSE_COMMANDS } from './datarefs.js';
import type { PauseCapability, SimSource, SimStatus } from './simSource.js';

export class MockSimulator implements SimSource {
  readonly source = 'mock' as const;
  private readonly emitter = new EventEmitter();
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private t = 0;
  private lastContactAt: number | null = null;
  private tdNm = 48;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SimStatus {
    const values: SimStatus['values'] = {
      paused: this.paused ? 1 : 0,
      altitudeFt: 37000 + Math.sin(this.t / 20) * 15,
      elevationM: (37000 + Math.sin(this.t / 20) * 15 + 450) / 3.280839895,
      groundspeedMs: 238 + Math.sin(this.t / 30) * 2,
      iasKt: 268 + Math.sin(this.t / 25) * 1.5,
      headingMag: (84 + Math.sin(this.t / 60) * 2 + 360) % 360,
      vsFpm: Math.round(Math.sin(this.t / 20) * 40),
      latitude: 48.35 + this.t * 0.0002,
      longitude: 11.78 + this.t * 0.0009,
      acfName: 'MOCK Boeing 737-800',
      acfIcao: 'B738',
      ziboTdDist: Math.max(this.tdNm, -5),
      ziboTdIdx: 7,
      ziboFlightPhase: this.tdNm > 0 ? 2 : 5,
    };
    return {
      source: 'mock',
      link: 'connected',
      linkDetail: 'MOCK simulator — not live data',
      xplaneVersion: 'mock',
      apiVersion: 'mock',
      values,
      available: new Set(Object.keys(values) as TelemetryKey[]),
      lastContactAt: this.lastContactAt,
    };
  }

  pauseCapability(): PauseCapability {
    return { ok: true, reason: null, mode: 'on_off' };
  }

  async readPaused(): Promise<boolean> {
    await delay(40);
    return this.paused;
  }

  async sendPauseCommand(targetPaused: boolean): Promise<string> {
    await delay(60);
    // Mimic X-Plane applying the command a few frames later.
    setTimeout(() => {
      this.paused = targetPaused;
      this.emitter.emit('change');
    }, 400);
    return targetPaused ? PAUSE_COMMANDS.on : PAUSE_COMMANDS.off;
  }

  onChange(listener: () => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private tick() {
    this.lastContactAt = Date.now();
    if (!this.paused) {
      this.t += 0.25;
      this.tdNm -= (238 * 1.9438) / 3600 / 4; // ~GS in NM per 250 ms
      if (this.tdNm < -5) this.tdNm = 60;
    }
    this.emitter.emit('change');
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
