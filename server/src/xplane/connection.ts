// Keeps a live connection to X-Plane's Web API:
//
//  1. Probe /api/capabilities (with exponential backoff while X-Plane is down).
//  2. Resolve every dataref/command this app uses BY NAME and validate types.
//  3. Open the WebSocket and subscribe to the resolved dataref ids (10 Hz,
//     X-Plane only sends values that changed).
//  4. While connected: a REST heartbeat re-reads sim/time/paused, aircraft-
//     specific datarefs (Zibo) are re-resolved periodically and after an
//     aircraft change, and a watchdog drops a silent WebSocket.
//  5. Any failure ends the session; the loop reconnects from step 1.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { SimLink } from '../shared/api-types.js';
import {
  ACCEPTED_VALUE_TYPES,
  ALLOWED_COMMAND_NAMES,
  DATAREFS,
  PAUSE_COMMANDS,
  normaliseValue,
  type DatarefSpec,
  type TelemetryKey,
} from './datarefs.js';
import {
  XPlaneApiError,
  XPlaneRestClient,
  type Capabilities,
  type CommandInfo,
  type DatarefInfo,
  type FetchLike,
} from './restClient.js';
import { silentLogger, type Logger, type PauseCapability, type SimSource, type SimStatus } from './simSource.js';

export interface ConnectionOptions {
  baseUrl: URL;
  requestTimeoutMs: number;
  pauseCommandMode: 'auto' | 'toggle';
  logger?: Logger;
  fetchImpl?: FetchLike;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  noFlightRetryMs?: number;
  heartbeatMs?: number;
  resolveIntervalMs?: number;
  /** Drop the WebSocket if it has been silent this long (X-Plane hung or socket half-open). */
  wsSilenceLimitMs?: number;
  wsRequestTimeoutMs?: number;
  now?: () => number;
}

class NoFlightError extends Error {}

interface ResolvedRef {
  spec: DatarefSpec;
  info: DatarefInfo;
}

const VERSION_PREFERENCE = ['v3', 'v2', 'v1'];

export class XPlaneConnection implements SimSource {
  readonly source = 'xplane' as const;

  private readonly rest: XPlaneRestClient;
  private readonly log: Logger;
  private readonly opts: Required<Omit<ConnectionOptions, 'logger' | 'fetchImpl'>>;
  private readonly emitter = new EventEmitter();

  private link: SimLink = 'disconnected';
  private linkDetail: string | null = 'Not started';
  private caps: Capabilities | null = null;

  private readonly refs = new Map<TelemetryKey, ResolvedRef>();
  private readonly idToKey = new Map<number, TelemetryKey>();
  private readonly values = new Map<TelemetryKey, number | string>();
  private readonly commands = new Map<string, CommandInfo>();
  private readonly typeWarnings = new Set<string>();
  private lastContactAt: number | null = null;
  private lastWsMessageAt = 0;

  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private sessionTimers: NodeJS.Timeout[] = [];
  private endSession: ((reason: string) => void) | null = null;
  private heartbeatFailures = 0;
  private aircraftResolveTimer: NodeJS.Timeout | null = null;

  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.log = options.logger ?? silentLogger;
    this.opts = {
      baseUrl: options.baseUrl,
      requestTimeoutMs: options.requestTimeoutMs,
      pauseCommandMode: options.pauseCommandMode,
      initialBackoffMs: options.initialBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 15000,
      noFlightRetryMs: options.noFlightRetryMs ?? 3000,
      heartbeatMs: options.heartbeatMs ?? 2000,
      resolveIntervalMs: options.resolveIntervalMs ?? 15000,
      wsSilenceLimitMs: options.wsSilenceLimitMs ?? 20000,
      wsRequestTimeoutMs: options.wsRequestTimeoutMs ?? 3000,
      now: options.now ?? Date.now,
    };
    this.rest = new XPlaneRestClient(options.baseUrl, options.requestTimeoutMs, options.fetchImpl);
  }

  // ---------------------------------------------------------------- SimSource

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.endSession?.('stopping');
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  status(): SimStatus {
    return {
      source: 'xplane',
      link: this.link,
      linkDetail: this.linkDetail,
      xplaneVersion: this.caps?.xplaneVersion ?? null,
      apiVersion: this.caps ? this.rest.apiVersion : null,
      values: Object.fromEntries(this.values) as SimStatus['values'],
      available: new Set(this.refs.keys()),
      lastContactAt: this.lastContactAt,
    };
  }

  pauseCapability(): PauseCapability {
    if (this.link !== 'connected') {
      return { ok: false, reason: this.linkDetail ?? 'Not connected to X-Plane', mode: null };
    }
    if (this.rest.apiVersion === 'v1') {
      return { ok: false, reason: 'Command activation needs X-Plane 12.1.4 or newer (Web API v2).', mode: null };
    }
    if (!this.refs.has('paused')) {
      return { ok: false, reason: 'sim/time/paused is not available, so the result could not be confirmed.', mode: null };
    }
    const hasOnOff = this.commands.has(PAUSE_COMMANDS.on) && this.commands.has(PAUSE_COMMANDS.off);
    if (this.opts.pauseCommandMode === 'auto' && hasOnOff) return { ok: true, reason: null, mode: 'on_off' };
    if (this.commands.has(PAUSE_COMMANDS.toggle)) return { ok: true, reason: null, mode: 'toggle' };
    return { ok: false, reason: 'X-Plane did not expose the pause commands.', mode: null };
  }

  async readPaused(): Promise<boolean> {
    const ref = this.refs.get('paused');
    if (!ref || this.link !== 'connected') throw new Error(this.linkDetail ?? 'Not connected to X-Plane');
    const raw = await this.rest.getDatarefValue(ref.info.id);
    const v = normaliseValue(ref.spec, raw);
    if (typeof v !== 'number') throw new XPlaneApiError('sim/time/paused returned a non-numeric value', 'protocol');
    this.markContact();
    this.setValue('paused', v);
    return v !== 0;
  }

  async sendPauseCommand(targetPaused: boolean): Promise<string> {
    const cap = this.pauseCapability();
    if (!cap.ok) throw new Error(cap.reason ?? 'Pause control unavailable');
    const name =
      cap.mode === 'on_off' ? (targetPaused ? PAUSE_COMMANDS.on : PAUSE_COMMANDS.off) : PAUSE_COMMANDS.toggle;
    // Defence in depth: this class only ever activates allow-listed commands.
    if (!ALLOWED_COMMAND_NAMES.includes(name)) throw new Error(`Command ${name} is not allowed`);
    const cmd = this.commands.get(name);
    if (!cmd) throw new Error(`Command ${name} not resolved`);
    await this.rest.activateCommand(cmd.id);
    this.log.info(`Activated ${name} (target paused=${targetPaused})`);
    return name;
  }

  onChange(listener: () => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  // ------------------------------------------------------------ main loop

  private async runLoop(): Promise<void> {
    let backoff = this.opts.initialBackoffMs;
    while (!this.stopped) {
      let delay = backoff;
      try {
        await this.runSession();
        backoff = this.opts.initialBackoffMs; // a session was established
        delay = backoff;
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof NoFlightError) {
          this.setLink('no_flight', err.message);
          delay = this.opts.noFlightRetryMs;
          backoff = this.opts.initialBackoffMs;
        } else {
          this.setLink('disconnected', describeError(err));
          backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
        }
      } finally {
        this.teardownSession();
      }
      if (this.stopped) break;
      await this.sleep(delay);
    }
    this.setLink('disconnected', 'Stopped');
  }

  private async runSession(): Promise<void> {
    if (this.link === 'disconnected') this.setLink('connecting', 'Contacting X-Plane Web API');
    const caps = await this.rest.capabilities();
    const version = VERSION_PREFERENCE.find((v) => caps.versions.includes(v));
    if (!version) throw new Error(`Unsupported X-Plane Web API versions: ${caps.versions.join(', ') || 'none'}`);
    this.rest.apiVersion = version;
    const firstContact = this.caps === null || this.caps.xplaneVersion !== caps.xplaneVersion;
    this.caps = caps;
    if (firstContact) this.log.info(`X-Plane ${caps.xplaneVersion ?? '(unknown version)'} — Web API ${caps.versions.join(', ')}; using ${version}`);

    // New session: ids may differ from the previous one, start clean.
    this.refs.clear();
    this.idToKey.clear();
    this.commands.clear();
    this.values.clear();
    this.setLink('connecting', 'Discovering datarefs');

    await this.resolveDatarefs(DATAREFS);
    if (!this.refs.has('paused')) {
      throw new NoFlightError('X-Plane is running but no flight is loaded yet.');
    }
    if (version !== 'v1') await this.resolveCommands();

    await this.heartbeat(true);
    await this.openWebSocket(version);
    const ok = await this.subscribe([...this.refs.values()].map((r) => r.info.id));
    if (!ok) throw new Error('X-Plane rejected the telemetry subscription');

    this.setLink('connected', null);
    this.log.info('Connected to X-Plane; telemetry subscribed');

    const sessionEnded = new Promise<string>((resolve) => {
      this.endSession = (reason) => {
        this.endSession = null;
        resolve(reason);
      };
    });
    this.ws?.once('close', () => this.endSession?.('WebSocket closed by X-Plane'));

    this.sessionTimers.push(
      setInterval(() => void this.heartbeat(false), this.opts.heartbeatMs),
      setInterval(() => void this.refreshDatarefs(), this.opts.resolveIntervalMs),
      setInterval(() => {
        if (this.opts.now() - this.lastWsMessageAt > this.opts.wsSilenceLimitMs) {
          this.endSession?.('No WebSocket traffic from X-Plane');
        }
      }, Math.min(5000, this.opts.wsSilenceLimitMs)),
    );

    const reason = await sessionEnded;
    if (!this.stopped) {
      this.log.warn(`X-Plane session ended: ${reason}`);
      this.setLink('disconnected', `Connection lost (${reason}); reconnecting…`);
    }
  }

  private teardownSession() {
    for (const t of this.sessionTimers) clearInterval(t);
    this.sessionTimers = [];
    if (this.aircraftResolveTimer) clearTimeout(this.aircraftResolveTimer);
    this.aircraftResolveTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {}); // swallow late errors from a dying socket
      this.ws.terminate();
      this.ws = null;
    }
    this.endSession = null;
    this.heartbeatFailures = 0;
  }

  // ------------------------------------------------------- discovery

  private async resolveDatarefs(specs: readonly DatarefSpec[]): Promise<{ added: number[]; removed: number[] }> {
    const infos = await this.rest.findDatarefs(specs.map((s) => s.name));
    const byName = new Map(infos.map((i) => [i.name, i]));
    const added: number[] = [];
    const removed: number[] = [];

    for (const spec of specs) {
      const info = byName.get(spec.name);
      const existing = this.refs.get(spec.key);
      const valid = info && ACCEPTED_VALUE_TYPES[spec.kind].includes(info.valueType);
      if (info && !valid && !this.typeWarnings.has(spec.name)) {
        this.typeWarnings.add(spec.name);
        this.log.warn(`Ignoring ${spec.name}: value_type "${info.valueType}" is not ${ACCEPTED_VALUE_TYPES[spec.kind].join('/')}`);
      }
      if (valid) {
        if (existing?.info.id === info.id) continue;
        if (existing) {
          this.idToKey.delete(existing.info.id);
          removed.push(existing.info.id);
        }
        this.refs.set(spec.key, { spec, info });
        this.idToKey.set(info.id, spec.key);
        added.push(info.id);
      } else if (existing) {
        this.refs.delete(spec.key);
        this.idToKey.delete(existing.info.id);
        this.values.delete(spec.key);
        removed.push(existing.info.id);
      }
    }
    if (added.length || removed.length) this.emitChange();
    return { added, removed };
  }

  private async resolveCommands() {
    const found = await this.rest.findCommands(ALLOWED_COMMAND_NAMES);
    this.commands.clear();
    for (const c of found) if (ALLOWED_COMMAND_NAMES.includes(c.name)) this.commands.set(c.name, c);
    const missing = ALLOWED_COMMAND_NAMES.filter((n) => !this.commands.has(n));
    if (missing.length) this.log.warn(`Pause commands not found: ${missing.join(', ')}`);
  }

  /** Periodic re-discovery: picks up Zibo datarefs once the aircraft finished loading, drops ones that vanished. */
  private async refreshDatarefs(specs: readonly DatarefSpec[] = DATAREFS) {
    if (this.link !== 'connected') return;
    try {
      const { added, removed } = await this.resolveDatarefs(specs);
      if (removed.length) await this.send('dataref_unsubscribe_values', { datarefs: removed.map((id) => ({ id })) });
      if (added.length) {
        this.log.info(`Subscribing to ${added.length} newly available dataref(s)`);
        await this.subscribe(added);
      }
      if (!this.refs.has('paused')) this.endSession?.('sim/time/paused disappeared');
      if (this.commands.size < ALLOWED_COMMAND_NAMES.length && this.rest.apiVersion !== 'v1') await this.resolveCommands();
    } catch (err) {
      this.log.debug(`Dataref refresh failed: ${describeError(err)}`);
    }
  }

  private onAircraftChanged() {
    this.log.info('Aircraft changed; re-discovering aircraft datarefs');
    for (const [key, ref] of this.refs) if (ref.spec.group === 'aircraft') this.values.delete(key);
    this.emitChange();
    if (this.aircraftResolveTimer) clearTimeout(this.aircraftResolveTimer);
    // Add-on datarefs are created while the aircraft loads; give it a moment.
    this.aircraftResolveTimer = setTimeout(() => void this.refreshDatarefs(), 3000);
  }

  // ------------------------------------------------------- heartbeat

  private async heartbeat(initial: boolean) {
    const ref = this.refs.get('paused');
    if (!ref) return;
    try {
      const raw = await this.rest.getDatarefValue(ref.info.id);
      this.heartbeatFailures = 0;
      this.markContact();
      const v = normaliseValue(ref.spec, raw);
      if (v !== null) this.setValue('paused', v);
    } catch (err) {
      if (initial) throw err;
      this.heartbeatFailures++;
      const idGone = err instanceof XPlaneApiError && err.code === 'invalid_dataref_id';
      if (idGone || this.heartbeatFailures >= 3) this.endSession?.(describeError(err));
    }
  }

  // ------------------------------------------------------- WebSocket

  private openWebSocket(version: string): Promise<void> {
    const url = new URL(`/api/${version}`, this.opts.baseUrl);
    url.protocol = 'ws:';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: this.opts.requestTimeoutMs, maxPayload: 4 * 1024 * 1024 });
      this.ws = ws;
      const fail = (err: Error) => reject(new XPlaneApiError(`WebSocket failed: ${err.message}`, 'network'));
      ws.once('error', fail);
      ws.once('open', () => {
        ws.off('error', fail);
        ws.on('error', (err) => this.log.warn(`WebSocket error: ${err.message}`));
        this.lastWsMessageAt = this.opts.now();
        resolve();
      });
      ws.on('message', (data) => this.onWsMessage(data));
    });
  }

  private onWsMessage(data: WebSocket.RawData) {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.lastWsMessageAt = this.opts.now();
    this.markContact();

    if (msg?.type === 'dataref_update_values' && msg.data && typeof msg.data === 'object') {
      let changed = false;
      for (const [idStr, raw] of Object.entries(msg.data as Record<string, unknown>)) {
        const key = this.idToKey.get(Number(idStr));
        if (!key) continue;
        const ref = this.refs.get(key)!;
        const value = normaliseValue(ref.spec, raw);
        const prev = this.values.get(key);
        if (value === null) {
          if (prev !== undefined) {
            this.values.delete(key);
            changed = true;
          }
          continue;
        }
        if (prev === value) continue;
        this.values.set(key, value);
        changed = true;
        if ((key === 'acfName' || key === 'acfIcao') && prev !== undefined) this.onAircraftChanged();
      }
      if (changed) this.emitChange();
    } else if (msg?.type === 'result' && typeof msg.req_id === 'number') {
      const p = this.pending.get(msg.req_id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        if (!msg.success) this.log.warn(`X-Plane request ${msg.req_id} failed: ${msg.error_code ?? ''} ${msg.error_message ?? ''}`);
        p.resolve(Boolean(msg.success));
      }
    }
  }

  private send(type: string, params: unknown): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const reqId = this.nextReqId++;
    if (this.nextReqId > 2_000_000_000) this.nextReqId = 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(false);
      }, this.opts.wsRequestTimeoutMs);
      this.pending.set(reqId, { resolve, timer });
      ws.send(JSON.stringify({ req_id: reqId, type, params }));
    });
  }

  /** Subscribe; if X-Plane rejects the batch (one bad id fails all), retry one by one and drop failures. */
  private async subscribe(ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    if (await this.send('dataref_subscribe_values', { datarefs: ids.map((id) => ({ id })) })) return true;
    let any = false;
    for (const id of ids) {
      if (await this.send('dataref_subscribe_values', { datarefs: [{ id }] })) {
        any = true;
      } else {
        const key = this.idToKey.get(id);
        if (key) {
          this.log.warn(`Dropping ${this.refs.get(key)?.spec.name}: subscription rejected`);
          this.refs.delete(key);
          this.values.delete(key);
          this.idToKey.delete(id);
        }
      }
    }
    return any && this.refs.has('paused');
  }

  // ------------------------------------------------------- helpers

  private setValue(key: TelemetryKey, value: number | string) {
    if (this.values.get(key) !== value) {
      this.values.set(key, value);
      this.emitChange();
    }
  }

  private markContact() {
    this.lastContactAt = this.opts.now();
  }

  private setLink(link: SimLink, detail: string | null) {
    if (this.link === link && this.linkDetail === detail) return;
    this.link = link;
    this.linkDetail = detail;
    this.emitChange();
  }

  private emitChange() {
    this.emitter.emit('change');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = null;
    });
  }
}

function describeError(err: unknown): string {
  if (err instanceof XPlaneApiError) {
    if (err.kind === 'network') return 'X-Plane is not running or its Web API is unavailable.';
    if (err.kind === 'timeout') return 'X-Plane is not responding (request timed out).';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
