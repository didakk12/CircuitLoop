/**
 * The real `SerialAdapter`, backed by the `serialport` native module.
 *
 * This is the ONLY file in the backend that imports `serialport` or
 * `@serialport/parser-readline`. Everything above it — the correlator, the
 * state machine, the service, the controller — talks to the `SerialAdapter`
 * interface, so none of them can accidentally grow a dependency on a native
 * module that may not be installable on a given machine.
 *
 * The import is deliberately *dynamic* and cached behind
 * {@link loadSerialPortModule}. `serialport` is a native addon: on a machine
 * with no prebuilt binary for its Node/OS/arch combination, or with the
 * package simply absent, a top-level `import` would throw while the module
 * graph is being evaluated — which happens during `src/index.ts`'s own
 * import, i.e. before Express exists, taking the entire API down over an
 * optional peripheral. Deferring it turns that same failure into a rejected
 * `listPorts()` promise, which `hardwareService` catches and reports as the
 * terminal `disabled` state while every other route keeps working.
 */

import type { PortInfo, SerialAdapter } from "./SerialAdapter.js";

// Minimal structural views of the two `serialport` types actually used here.
// Declared locally rather than imported so this file's *types* don't depend
// on the native module resolving either — the same reasoning as the dynamic
// import above, applied at compile time.
interface SerialPortLike {
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  set(options: { dtr: boolean; rts: boolean }, callback: (error: Error | null) => void): void;
  write(data: string, callback: (error: Error | null | undefined) => void): boolean;
  pipe<T>(destination: T): T;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(): unknown;
  readonly isOpen: boolean;
}

interface SerialPortModule {
  SerialPort: {
    list(): Promise<Array<{
      path: string;
      vendorId?: string | undefined;
      productId?: string | undefined;
      manufacturer?: string | undefined;
    }>>;
    new (options: { path: string; baudRate: number; autoOpen: boolean }): SerialPortLike;
  };
  ReadlineParser: new (options: { delimiter: string }) => {
    on(event: "data", listener: (line: string) => void): unknown;
    removeAllListeners(): unknown;
  };
}

let modulePromise: Promise<SerialPortModule> | null = null;

/**
 * Loads `serialport` once per process.
 *
 * The promise is cached including its rejection: on a machine without the
 * native module, retrying the import on every 3-second scan tick would
 * re-walk the resolver and re-throw the same error forever. One attempt is
 * enough to establish the answer.
 */
function loadSerialPortModule(): Promise<SerialPortModule> {
  modulePromise ??= import("serialport").then(
    (loaded) => loaded as unknown as SerialPortModule,
    (error: unknown) => {
      throw new Error(
        `The 'serialport' native module could not be loaded, so serial hardware is unavailable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  return modulePromise;
}

/** Promisifies one of `serialport`'s Node-style callback methods. */
function promisify(invoke: (callback: (error: Error | null | undefined) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    invoke((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export class NodeSerialAdapter implements SerialAdapter {
  #port: SerialPortLike | null = null;
  #parser: InstanceType<SerialPortModule["ReadlineParser"]> | null = null;
  readonly #lineHandlers: Array<(line: string) => void> = [];
  readonly #closeHandlers: Array<(error: Error | null) => void> = [];

  async listPorts(): Promise<PortInfo[]> {
    const { SerialPort } = await loadSerialPortModule();
    const ports = await SerialPort.list();
    return ports.map((port) => ({
      path: port.path,
      ...(port.vendorId === undefined ? {} : { vendorId: port.vendorId }),
      ...(port.productId === undefined ? {} : { productId: port.productId }),
      ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
    }));
  }

  async open(path: string, options: { baudRate: number }): Promise<void> {
    const { SerialPort, ReadlineParser } = await loadSerialPortModule();

    // `autoOpen: false` so the open is a single awaited step with a real
    // error, instead of a constructor that succeeds and then emits 'error'
    // asynchronously at a point where nothing is listening yet.
    const port = new SerialPort({ path, baudRate: options.baudRate, autoOpen: false });
    await promisify((callback) => {
      port.open(callback);
    });

    // ESP32 firmware terminates with "\n"; boards that send CRLF leave a
    // trailing "\r", trimmed below so the correlator always sees clean text.
    const parser = new ReadlineParser({ delimiter: "\n" });
    port.pipe(parser);
    parser.on("data", (line: string) => {
      const trimmed = line.replace(/\r$/, "");
      for (const handler of this.#lineHandlers) {
        handler(trimmed);
      }
    });

    // 'error' and 'close' are both terminal for our purposes: the state
    // machine's only reaction to either is to tear down and rescan. 'error'
    // is mapped through the same close path so an unplug — which surfaces as
    // an error on some platforms and a bare close on others — is handled
    // identically everywhere.
    port.on("close", (error: never) => {
      this.#emitClose((error as unknown as Error | null | undefined) ?? null);
    });
    port.on("error", (error: never) => {
      this.#emitClose((error as unknown as Error | undefined) ?? new Error("Serial port error"));
    });

    this.#port = port;
    this.#parser = parser;
  }

  async setSignals(signals: { dtr: boolean; rts: boolean }): Promise<void> {
    const port = this.#port;
    if (port === null) {
      throw new Error("Cannot set serial signals: no port is open.");
    }
    await promisify((callback) => {
      port.set(signals, callback);
    });
  }

  async write(data: string): Promise<void> {
    const port = this.#port;
    if (port === null) {
      throw new Error("Cannot write to serial port: no port is open.");
    }
    await promisify((callback) => {
      port.write(data, callback);
    });
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  onClose(handler: (error: Error | null) => void): void {
    this.#closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    const port = this.#port;
    const parser = this.#parser;
    this.#port = null;
    this.#parser = null;
    // Handlers are dropped before the close is issued so the resulting
    // 'close' event can't re-enter the state machine as a surprise
    // disconnect during an intentional teardown.
    this.#lineHandlers.length = 0;
    this.#closeHandlers.length = 0;

    parser?.removeAllListeners();
    if (port === null) {
      return;
    }
    port.removeAllListeners();
    if (!port.isOpen) {
      return;
    }
    await promisify((callback) => {
      port.close(callback);
    });
  }

  #emitClose(error: Error | null): void {
    for (const handler of [...this.#closeHandlers]) {
      handler(error);
    }
  }
}
