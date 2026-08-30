/**
 * The serial port abstraction the hardware state machine is written against.
 *
 * `hardwareService.ts` depends on this interface and nothing else — it never
 * imports `serialport`, never sees a `SerialPort` instance, and never handles
 * a raw byte stream. Two consequences follow, and both are the point:
 *
 *   1. The entire state machine is testable with no hardware and no native
 *      module, by injecting `MockSerialAdapter`.
 *   2. A missing, broken, or permission-denied `serialport` install is an
 *      ordinary rejected promise from `listPorts()`/`open()` rather than an
 *      import-time crash, which is what lets the service degrade to
 *      `disabled` while the rest of the API keeps serving requests.
 *
 * Implementations are expected to be *line*-oriented: `onLine` delivers whole
 * lines with the terminator already stripped, so the correlator and state
 * machine never do buffering or framing themselves.
 */

/** One serial port as reported by the host. `vendorId`/`productId` are uppercase-hex USB ids where the platform exposes them. */
export interface PortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
}

export interface SerialAdapter {
  /** Every serial port currently visible to the host. Rejects if enumeration itself is unavailable (missing native module, denied permission). */
  listPorts(): Promise<PortInfo[]>;
  /** Opens `path`. Rejects if the port is busy, gone, or not permitted. */
  open(path: string, options: { baudRate: number }): Promise<void>;
  /**
   * Sets the DTR/RTS control lines on the open port.
   *
   * Called best-effort by the state machine: on many ESP32 dev boards these
   * lines are wired to EN/BOOT, so asserting them on open reboots the board
   * mid-probe. Platforms that don't support setting them may reject, and the
   * caller treats that as non-fatal.
   */
  setSignals(signals: { dtr: boolean; rts: boolean }): Promise<void>;
  /** Writes `data` verbatim to the open port. The caller supplies any line terminator. */
  write(data: string): Promise<void>;
  /** Registers a handler for each complete line received, terminator stripped. */
  onLine(handler: (line: string) => void): void;
  /** Registers a handler for the port closing — `error` is non-null when it closed *because* of a failure (unplugged mid-session). */
  onClose(handler: (error: Error | null) => void): void;
  /** Closes the port and releases every listener. Safe to call when already closed. */
  close(): Promise<void>;
}
