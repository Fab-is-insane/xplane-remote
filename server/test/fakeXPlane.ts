// A small fake of the X-Plane 12 Web API (REST + WebSocket) for tests.
// It mimics the documented behaviour: name filters, session ids, 10 Hz-ish
// update pushes of changed values, and command activation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeDataref {
  id: number;
  name: string;
  value_type: string;
  value: unknown;
}

export interface FakeOptions {
  versions?: string[];
  xplaneVersion?: string;
  /** No flight loaded: dataref/command lists are empty. */
  noFlight?: boolean;
  /** Include sim/operation/pause_on / pause_off. */
  onOffCommands?: boolean;
  /** What a pause command does. */
  commandBehavior?: 'apply' | 'ignore' | 'error';
  commandApplyDelayMs?: number;
  /** Never answer value reads (to test timeouts). */
  hangValueReads?: boolean;
  updateIntervalMs?: number;
  extraDatarefs?: Array<Omit<FakeDataref, 'id'>>;
}

export class FakeXPlane {
  server: Server;
  wss: WebSocketServer;
  port = 0;
  paused = false;
  activations: string[] = [];
  /** Number of names in each GET /datarefs?filter[name]=… request, in order. */
  datarefQueries: number[] = [];
  datarefs: FakeDataref[] = [];
  commands: Array<{ id: number; name: string; description: string }> = [];
  private sockets = new Set<WebSocket>();
  private timers: NodeJS.Timeout[] = [];

  constructor(public opts: FakeOptions = {}) {
    let id = 1000;
    const dr = (name: string, value_type: string, value: unknown) => ({ id: id++, name, value_type, value });
    this.datarefs = [
      dr('sim/time/paused', 'int', 0),
      dr('sim/time/total_running_time_sec', 'float', 100),
      dr('sim/cockpit2/gauges/indicators/altitude_ft_pilot', 'float', 35000),
      dr('sim/flightmodel/position/elevation', 'double', 10668),
      dr('sim/flightmodel/position/groundspeed', 'float', 230),
      dr('sim/cockpit2/gauges/indicators/airspeed_kts_pilot', 'float', 270),
      dr('sim/flightmodel/position/mag_psi', 'float', 92.4),
      dr('sim/cockpit2/gauges/indicators/vvi_fpm_pilot', 'float', 0),
      dr('sim/flightmodel/position/latitude', 'double', 51.47),
      dr('sim/flightmodel/position/longitude', 'double', -0.45),
      dr('sim/aircraft/view/acf_ICAO', 'data', Buffer.from('B738\0\0\0').toString('base64')),
      dr('sim/aircraft/view/acf_ui_name', 'data', Buffer.from('Boeing 737-800X\0').toString('base64')),
      ...(opts.extraDatarefs ?? []).map((d) => dr(d.name, d.value_type, d.value)),
    ];
    let cid = 5000;
    this.commands = [{ id: cid++, name: 'sim/operation/pause_toggle', description: 'Toggle simulation paused state.' }];
    if (opts.onOffCommands !== false) {
      this.commands.push({ id: cid++, name: 'sim/operation/pause_on', description: 'Pause the simulation.' });
      this.commands.push({ id: cid++, name: 'sim/operation/pause_off', description: 'Unpause the simulation.' });
    }
    this.server = createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const versions = this.opts.versions ?? ['v1', 'v2', 'v3'];
      const v = req.url?.match(/^\/api\/(v\d)$/)?.[1];
      if (!v || !versions.includes(v)) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  get url() {
    return new URL(`http://127.0.0.1:${this.port}`);
  }

  async listen(port = 0): Promise<this> {
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close() {
    for (const t of this.timers) clearInterval(t);
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Drop all WebSocket clients (simulates X-Plane closing the socket). */
  dropSockets() {
    for (const s of this.sockets) s.terminate();
  }

  setValue(name: string, value: unknown) {
    const d = this.datarefs.find((x) => x.name === name);
    if (d) d.value = value;
  }

  private ref(name: string) {
    return this.datarefs.find((d) => d.name === name)!;
  }

  private setPaused(p: boolean) {
    this.paused = p;
    this.ref('sim/time/paused').value = p ? 1 : 0;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const versions = this.opts.versions ?? ['v1', 'v2', 'v3'];

    if (url.pathname === '/api/capabilities') {
      if (!versions.includes('v2')) return this.json(res, 404, { error_code: 'not_found', error_message: 'not found' });
      return this.json(res, 200, { api: { versions }, 'x-plane': { version: this.opts.xplaneVersion ?? '12.4.3' } });
    }

    const m = url.pathname.match(/^\/api\/(v\d)\/(.*)$/);
    if (!m || !versions.includes(m[1]!)) return this.json(res, 404, { error_code: 'not_found', error_message: 'no route' });
    const route = m[2]!;
    const names = url.searchParams.getAll('filter[name]');

    if (route === 'datarefs/count') return this.json(res, 200, { data: this.opts.noFlight ? 0 : this.datarefs.length });
    if (route === 'datarefs') {
      const list = this.opts.noFlight ? [] : this.datarefs.filter((d) => names.length === 0 || names.includes(d.name));
      // Like real X-Plane 12.4.3: one unknown name fails the whole batch.
      const unknown = names.find((n) => !list.some((d) => d.name === n));
      if (unknown !== undefined && !this.opts.noFlight) {
        this.datarefQueries.push(names.length);
        return this.json(res, 404, { error_code: 'invalid_dataref_name', error_message: `Dataref name '${unknown}' doesn't exist` });
      }
      this.datarefQueries.push(names.length);
      return this.json(res, 200, { data: list.map(({ id, name, value_type }) => ({ id, name, value_type })) });
    }
    const vm = route.match(/^datarefs\/(\d+)\/value$/);
    if (vm) {
      if (this.opts.hangValueReads) return; // never answer
      const d = this.datarefs.find((x) => x.id === Number(vm[1]));
      if (!d) return this.json(res, 404, { error_code: 'invalid_dataref_id', error_message: 'bad id' });
      return this.json(res, 200, { data: d.value });
    }
    if (route === 'commands') {
      if (m[1] === 'v1') return this.json(res, 404, { error_code: 'not_found', error_message: 'no route' });
      const list = this.opts.noFlight ? [] : this.commands.filter((c) => names.length === 0 || names.includes(c.name));
      return this.json(res, 200, { data: list });
    }
    const cm = route.match(/^command\/(\d+)\/activate$/);
    if (cm && req.method === 'POST') {
      const cmd = this.commands.find((c) => c.id === Number(cm[1]));
      if (!cmd) return this.json(res, 404, { error_code: 'invalid_command_id', error_message: 'bad id' });
      if (this.opts.commandBehavior === 'error') return this.json(res, 500, { error_code: 'internal', error_message: 'boom' });
      this.activations.push(cmd.name);
      if (this.opts.commandBehavior !== 'ignore') {
        const apply = () => {
          if (cmd.name === 'sim/operation/pause_toggle') this.setPaused(!this.paused);
          if (cmd.name === 'sim/operation/pause_on') this.setPaused(true);
          if (cmd.name === 'sim/operation/pause_off') this.setPaused(false);
        };
        setTimeout(apply, this.opts.commandApplyDelayMs ?? 50);
      }
      return this.json(res, 200, null);
    }
    return this.json(res, 404, { error_code: 'not_found', error_message: 'no route' });
  }

  private onSocket(ws: WebSocket) {
    this.sockets.add(ws);
    const subscribed = new Set<number>();
    const last = new Map<number, string>();
    const push = () => {
      const data: Record<string, unknown> = {};
      for (const id of subscribed) {
        const d = this.datarefs.find((x) => x.id === id);
        if (!d) continue;
        if (d.name === 'sim/time/total_running_time_sec') d.value = (d.value as number) + 0.05;
        const ser = JSON.stringify(d.value);
        if (last.get(id) !== ser) {
          last.set(id, ser);
          data[String(id)] = d.value;
        }
      }
      if (Object.keys(data).length) ws.send(JSON.stringify({ type: 'dataref_update_values', data }));
    };
    const t = setInterval(push, this.opts.updateIntervalMs ?? 50);
    this.timers.push(t);
    ws.on('close', () => {
      clearInterval(t);
      this.sockets.delete(ws);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'dataref_subscribe_values') {
        const ids: number[] = msg.params.datarefs.map((d: { id: number }) => d.id);
        const bad = ids.find((id) => !this.datarefs.some((d) => d.id === id));
        if (bad !== undefined) {
          ws.send(JSON.stringify({ req_id: msg.req_id, type: 'result', success: false, error_code: 'invalid_dataref_id' }));
          return;
        }
        ids.forEach((id) => subscribed.add(id));
        ws.send(JSON.stringify({ req_id: msg.req_id, type: 'result', success: true }));
      } else if (msg.type === 'dataref_unsubscribe_values') {
        for (const d of msg.params.datarefs) subscribed.delete(d.id);
        ws.send(JSON.stringify({ req_id: msg.req_id, type: 'result', success: true }));
      } else {
        ws.send(JSON.stringify({ req_id: msg.req_id, type: 'result', success: false, error_code: 'invalid_type' }));
      }
    });
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 4000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A port that nothing is listening on. */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
