// The interface the rest of the server uses to talk to "a simulator".
// Implemented by XPlaneConnection (real) and MockSimulator (development only).

import type { DataSource, SimLink } from '../shared/api-types.js';
import type { TelemetryKey, TelemetryValue } from './datarefs.js';

export interface SimStatus {
  source: DataSource;
  link: SimLink;
  linkDetail: string | null;
  xplaneVersion: string | null;
  apiVersion: string | null;
  /** Last known normalised values, by key. Absent = never received or no longer valid. */
  values: Partial<Record<TelemetryKey, TelemetryValue>>;
  /** Datarefs that currently exist in the simulator (resolved by name). */
  available: ReadonlySet<TelemetryKey>;
  /** Epoch ms of the last confirmed contact with the simulator. */
  lastContactAt: number | null;
}

export type PauseCommandMode = 'on_off' | 'toggle';

export interface PauseCapability {
  ok: boolean;
  reason: string | null;
  mode: PauseCommandMode | null;
}

export interface SimSource {
  readonly source: DataSource;
  start(): void;
  stop(): Promise<void>;
  status(): SimStatus;
  pauseCapability(): PauseCapability;
  /** Fresh read of sim/time/paused from the simulator. Throws if it cannot be read. */
  readPaused(): Promise<boolean>;
  /**
   * Activate the pause command that moves the sim towards `targetPaused`.
   * Resolves when the simulator accepted the request, which does NOT mean
   * the state changed. Returns the command name used.
   */
  sendPauseCommand(targetPaused: boolean): Promise<string>;
  /** Subscribe to "something changed" notifications. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
