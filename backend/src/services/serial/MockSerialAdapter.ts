/**
 * In-memory `SerialAdapter` used by every hardware state-machine test.
 *
 * It is not a stub that returns canned values — it models the behaviours the
 * state machine actually has to survive, and lets a test drive each one
 * explicitly: a board that answers, one that stays silent until the ACK
 * times out, a port that is busy or permission-denied, an enumeration call
 * that fails outright (a missing native module), and a cable pulled
 * mid-probe.
 *
 * Lives in `src/` rather than `tests/` on purpose: it implements a `src/`
 * interface and must fail to compile the moment that interface changes,
 * which is the whole value of having the abstraction. It imports nothing but
 * the interface, so it adds no weight to the production bundle.
 */

import type { PortInfo, SerialAdapter } from "./SerialAdapter.js";

export interface MockSerialAdapterOptions {
  /** Ports `listPorts()` reports. Defaults to a single CH340 board at `COM_TEST`. */
  ports?: PortInfo[];
  /** When set, `listPorts()` rejects with this — models a missing/broken `serialport` install. */
  listPortsError?: Error;
  /** When set, `open()` rejects with this — models a busy port or denied permission. */
  openError?: Error;
  /** When set, `write()` rejects with this — models a cable pulled between open and probe. */
  writeError?: Error;
  /** When set, `setSignals()` rejects with this. The state machine treats it as non-fatal. */
  setSignalsError?: Error;
  /**
   * Reply written back for each line the state machine sends, as a function
   * of that line. Returning `null` (the default) means the board stays
   * silent, which is how an ACK-timeout test is written.
   */
  autoRespond?: (written: string) => string | null;
}

/** A CH340-based ESP32 board, matching the default VID/PID allowlist. */
export const DEFAULT_MOCK_PORT: PortInfo = {
  path: "COM_TEST",
  vendorId: "1A86",
  productId: "7523",
  manufacturer: "wch.cn",
};

export class MockSerialAdapter implements SerialAdapter {
  /** Every line written by the state machine, in order — the assertion surface for "did it probe?". */
  readonly written: string[] = [];
  /** Every `setSignals` call, in order. */
  readonly signalCalls: Array<{ dtr: boolean; rts: boolean }> = [];
  /** Counts calls, so a test can assert scanning actually polls rather than trying once. */
  listPortsCallCount = 0;
  openCallCount = 0;
  closeCallCount = 0;
  /** The currently open port path, or null. */
  openedPath: string | null = null;

  #options: MockSerialAdapterOptions;
  #lineHandlers: Array<(line: string) => void> = [];
  #closeHandlers: Array<(error: Error | null) => void> = [];

  constructor(options: MockSerialAdapterOptions = {}) {
    this.#options = options;
  }

  /** Replaces the adapter's behaviour mid-test — e.g. a board that starts answering only after a reconnect. */
  configure(options: MockSerialAdapterOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  listPorts(): Promise<PortInfo[]> {
    this.listPortsCallCount += 1;
    if (this.#options.listPortsError) {
      return Promise.reject(this.#options.listPortsError);
    }
    return Promise.resolve(this.#options.ports ?? [DEFAULT_MOCK_PORT]);
  }

  open(path: string, _options: { baudRate: number }): Promise<void> {
    this.openCallCount += 1;
    if (this.#options.openError) {
      return Promise.reject(this.#options.openError);
    }
    this.openedPath = path;
    return Promise.resolve();
  }

  setSignals(signals: { dtr: boolean; rts: boolean }): Promise<void> {
    this.signalCalls.push(signals);
    if (this.#options.setSignalsError) {
      return Promise.reject(this.#options.setSignalsError);
    }
    return Promise.resolve();
  }

  write(data: string): Promise<void> {
    if (this.#options.writeError) {
      return Promise.reject(this.#options.writeError);
    }
    this.written.push(data);
    const reply = this.#options.autoRespond?.(data) ?? null;
    if (reply !== null) {
      // Delivered on a later microtask, like a real port: a synchronous
      // reply would resolve the ACK before `write()`'s own promise settles
      // and hide ordering bugs the real adapter would expose.
      queueMicrotask(() => {
        this.emitLine(reply);
      });
    }
    return Promise.resolve();
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  onClose(handler: (error: Error | null) => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): Promise<void> {
    this.closeCallCount += 1;
    this.openedPath = null;
    this.#lineHandlers = [];
    this.#closeHandlers = [];
    return Promise.resolve();
  }

  // --- Test drivers -------------------------------------------------------

  /** Delivers one line to the state machine, as though the board had sent it. */
  emitLine(line: string): void {
    for (const handler of [...this.#lineHandlers]) {
      handler(line);
    }
  }

  /** Simulates the port closing — pass an error for an unplug, `null` for a clean close. */
  emitClose(error: Error | null = null): void {
    this.openedPath = null;
    for (const handler of [...this.#closeHandlers]) {
      handler(error);
    }
  }

  /** True while at least one line listener is attached — proves `stop()`/`close()` really detach. */
  get hasListeners(): boolean {
    return this.#lineHandlers.length > 0 || this.#closeHandlers.length > 0;
  }
}
