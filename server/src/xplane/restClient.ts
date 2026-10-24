// Minimal client for the X-Plane 12 local Web API (REST part).
// https://developer.x-plane.com/article/x-plane-web-api/
//
//   GET  /api/capabilities                       (v2+, unversioned path)
//   GET  /api/{v}/datarefs?filter[name]=...      discover datarefs by name
//   GET  /api/{v}/datarefs/{id}/value
//   GET  /api/{v}/commands?filter[name]=...      (v2+)
//   POST /api/{v}/command/{id}/activate          (v2+) body {"duration": 0}
//
// The client is deliberately narrow: it can only read values and activate
// commands by id. Which ids are allowed is decided by the caller.

export type XPlaneErrorKind = 'network' | 'timeout' | 'http' | 'protocol';

export class XPlaneApiError extends Error {
  constructor(
    message: string,
    public readonly kind: XPlaneErrorKind,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'XPlaneApiError';
  }
}

export interface Capabilities {
  versions: string[];
  xplaneVersion: string | null;
}

export interface DatarefInfo {
  id: number;
  name: string;
  valueType: string;
  isWritable: boolean | null;
}

export interface CommandInfo {
  id: number;
  name: string;
  description: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class XPlaneRestClient {
  /** API version used for versioned routes. Set after capability detection. */
  apiVersion = 'v1';

  constructor(
    private readonly baseUrl: URL,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * Detect API versions. X-Plane 12.1.1–12.1.3 only offers v1 and has no
   * capabilities endpoint; in that case we probe v1 and report ['v1'].
   */
  async capabilities(): Promise<Capabilities> {
    try {
      const body = await this.request<any>('GET', '/api/capabilities');
      const versions = Array.isArray(body?.api?.versions)
        ? body.api.versions.filter((v: unknown): v is string => typeof v === 'string')
        : [];
      const xv = body?.['x-plane']?.version;
      return { versions, xplaneVersion: typeof xv === 'string' ? xv : null };
    } catch (err) {
      if (err instanceof XPlaneApiError && err.kind === 'http' && err.status === 404) {
        await this.request('GET', '/api/v1/datarefs/count');
        return { versions: ['v1'], xplaneVersion: null };
      }
      throw err;
    }
  }

  async datarefCount(): Promise<number> {
    const body = await this.request<any>('GET', `/api/${this.apiVersion}/datarefs/count`);
    return typeof body?.data === 'number' ? body.data : 0;
  }

  /** Look up datarefs by exact name. Names that do not exist are simply absent from the result. */
  async findDatarefs(names: readonly string[]): Promise<DatarefInfo[]> {
    if (names.length === 0) return [];
    try {
      const body = await this.request<any>('GET', `/api/${this.apiVersion}/datarefs?${nameFilter(names)}`);
      return parseList(body, parseDataref);
    } catch (err) {
      // If the server rejects the whole batch because one name is unknown,
      // fall back to one request per name.
      if (err instanceof XPlaneApiError && err.kind === 'http' && err.status === 404 && names.length > 1) {
        const out: DatarefInfo[] = [];
        for (const n of names) out.push(...(await this.findDatarefs([n]).catch(() => [])));
        return out;
      }
      throw err;
    }
  }

  async findCommands(names: readonly string[]): Promise<CommandInfo[]> {
    if (names.length === 0) return [];
    try {
      const body = await this.request<any>('GET', `/api/${this.apiVersion}/commands?${nameFilter(names)}`);
      return parseList(body, parseCommand);
    } catch (err) {
      if (err instanceof XPlaneApiError && err.kind === 'http' && err.status === 404 && names.length > 1) {
        const out: CommandInfo[] = [];
        for (const n of names) out.push(...(await this.findCommands([n]).catch(() => [])));
        return out;
      }
      throw err;
    }
  }

  async getDatarefValue(id: number): Promise<unknown> {
    assertId(id);
    const body = await this.request<any>('GET', `/api/${this.apiVersion}/datarefs/${id}/value`);
    if (body === null || typeof body !== 'object' || !('data' in body)) {
      throw new XPlaneApiError('Unexpected dataref value response', 'protocol');
    }
    return body.data;
  }

  /** Press and release a command once (duration 0). */
  async activateCommand(id: number): Promise<void> {
    assertId(id);
    await this.request('POST', `/api/${this.apiVersion}/command/${id}/activate`, { duration: 0 });
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new XPlaneApiError(`X-Plane did not answer within ${this.timeoutMs} ms`, 'timeout');
      }
      throw new XPlaneApiError(`X-Plane Web API not reachable (${(err as Error).message})`, 'network');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new XPlaneApiError('X-Plane returned invalid JSON', 'protocol', res.status);
      }
    }
    if (!res.ok) {
      const code = typeof json?.error_code === 'string' ? json.error_code : undefined;
      const msg = typeof json?.error_message === 'string' ? json.error_message : `HTTP ${res.status}`;
      throw new XPlaneApiError(
        res.status === 403 && !code
          ? 'X-Plane refused the request (403). Check Settings > Network: incoming traffic must not be disabled.'
          : `X-Plane: ${msg}`,
        'http',
        res.status,
        code,
      );
    }
    return json as T;
  }
}

function assertId(id: number) {
  if (!Number.isInteger(id) || id <= 0) throw new XPlaneApiError(`Invalid id ${id}`, 'protocol');
}

// filter[name]=a&filter[name]=b — names only contain [A-Za-z0-9_/], so
// slashes are left readable and everything else is percent-encoded.
function nameFilter(names: readonly string[]): string {
  return names.map((n) => `filter[name]=${encodeURIComponent(n).replace(/%2F/gi, '/')}`).join('&');
}

function parseList<T>(body: any, parse: (raw: any) => T | null): T[] {
  const data = body?.data;
  const items = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  return items.map(parse).filter((x): x is T => x !== null);
}

function parseDataref(raw: any): DatarefInfo | null {
  if (!raw || typeof raw.id !== 'number' || typeof raw.name !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    valueType: typeof raw.value_type === 'string' ? raw.value_type : 'unknown',
    isWritable: typeof raw.is_writable === 'boolean' ? raw.is_writable : null,
  };
}

function parseCommand(raw: any): CommandInfo | null {
  if (!raw || typeof raw.id !== 'number' || typeof raw.name !== 'string') return null;
  return { id: raw.id, name: raw.name, description: typeof raw.description === 'string' ? raw.description : null };
}
