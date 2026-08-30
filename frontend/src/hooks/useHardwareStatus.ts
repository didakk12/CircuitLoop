import { useEffect, useRef, useState } from "react";

import {
  getHardwareStatus,
  streamHardwareStatus,
  type ApiHardwareStatus,
  type HardwareState,
} from "../api";

/**
 * How the hook is currently getting its data.
 *
 * This is deliberately separate from the hardware's own `state`: they answer
 * different questions. `state` is "what is the board doing", `mode` is "how
 * much should you trust that answer right now". A board reported as
 * `connected` while `mode` is `"lost"` is a value we last saw some time ago
 * and can no longer refresh — and conflating the two is exactly how a
 * dashboard ends up confidently showing a green light for a server that went
 * away twenty minutes ago.
 */
export type HardwareMode = "stream" | "poll" | "lost";

export interface UseHardwareStatusResult {
  /** The hardware state machine's state — what the UI should render from. */
  state: HardwareState;
  /** Convenience for `state === "connected"`; see ApiHardwareStatus.connected. */
  connected: boolean;
  mode: HardwareMode;
  /** The full last-known status, or null before the first frame has ever arrived. */
  status: ApiHardwareStatus | null;
}

export interface UseHardwareStatusOptions {
  /** Injectable for tests. Defaults to the real SSE client. */
  stream?: typeof streamHardwareStatus;
  /** Injectable for tests. Defaults to the real polling client. */
  poll?: typeof getHardwareStatus;
  /** First reconnect delay; each subsequent failure doubles it. */
  baseBackoffMs?: number;
  /** Ceiling for the backoff, so a long outage settles into a steady retry rather than hours-long gaps. */
  maxBackoffMs?: number;
  /** Consecutive failed reconnects before falling back to polling. */
  failuresBeforePolling?: number;
  /** Fixed interval for the polling fallback. */
  pollIntervalMs?: number;
  /** Jitter source. Injectable so tests get an exact, reproducible backoff sequence. */
  random?: () => number;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_FAILURES_BEFORE_POLLING = 5;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, then capped.
 *
 * The jitter is not decoration. Every browser tab watching this dashboard
 * disconnects at the same instant when the backend restarts, so without it
 * they would all retry in lockstep and hammer the server in synchronised
 * waves precisely while it is trying to come back up. Spreading each delay
 * across ±25% breaks up the convoy.
 *
 * Exported for its own unit test — the sequence is easier to pin down
 * directly than to infer from timer behaviour.
 */
export function backoffDelayMs(
  consecutiveFailures: number,
  options: { baseMs: number; maxMs: number; random: () => number },
): number {
  const exponential = options.baseMs * 2 ** Math.max(0, consecutiveFailures - 1);
  const capped = Math.min(exponential, options.maxMs);
  return Math.round(capped * (0.75 + options.random() * 0.5));
}

/**
 * Live hardware status, resilient to the backend going away.
 *
 * The policy, in order:
 *
 *  1. Hold an SSE connection open and render every frame.
 *  2. If it drops or fails to open, reconnect with exponential backoff.
 *  3. After `failuresBeforePolling` consecutive failures, *additionally*
 *     start polling on a fixed interval, so the badge keeps updating
 *     through an outage instead of freezing on the last frame it saw.
 *  4. Keep retrying SSE in the background throughout. The moment one
 *     succeeds, polling stops and the live stream takes over again.
 *  5. If polling fails too, the backend is genuinely unreachable and that
 *     is reported honestly as `mode: "lost"` rather than by continuing to
 *     display a stale value as though it were current.
 */
export function useHardwareStatus(options: UseHardwareStatusOptions = {}): UseHardwareStatusResult {
  const [status, setStatus] = useState<ApiHardwareStatus | null>(null);
  // Starts as "stream" because that is what the hook is genuinely doing from
  // its first tick — attempting the live connection. `status === null`, not
  // the mode, is what says "nothing known yet".
  const [mode, setMode] = useState<HardwareMode>("stream");

  // Options are read through a ref so that a caller passing an inline object
  // literal (the overwhelmingly common case) doesn't retrigger the effect on
  // every render and tear the SSE connection down in a loop.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const {
      stream = streamHardwareStatus,
      poll = getHardwareStatus,
      baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
      failuresBeforePolling = DEFAULT_FAILURES_BEFORE_POLLING,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      random = Math.random,
    } = optionsRef.current;

    let cancelled = false;
    let consecutiveFailures = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollingActive = false;
    const controllers = new Set<AbortController>();

    function stopPolling(): void {
      pollingActive = false;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    function startPolling(): void {
      if (pollingActive || cancelled) {
        return;
      }
      pollingActive = true;

      const tick = async (): Promise<void> => {
        if (cancelled || !pollingActive) {
          return;
        }
        try {
          const polled = await poll();
          if (cancelled || !pollingActive) {
            return;
          }
          setStatus(polled);
          setMode("poll");
        } catch {
          if (cancelled || !pollingActive) {
            return;
          }
          // Neither transport works. Say so, rather than leaving a stale
          // value on screen looking authoritative.
          setMode("lost");
        }
        if (!cancelled && pollingActive) {
          pollTimer = setTimeout(() => void tick(), pollIntervalMs);
        }
      };

      // Poll immediately on entering fallback — the whole point is to refresh
      // a value that has already been stale for several failed reconnects.
      pollTimer = setTimeout(() => void tick(), 0);
    }

    /**
     * Nothing cancels this timer directly. `cancelled` is rechecked at the
     * top of the loop once it resolves, which is sufficient because the
     * delay is bounded by `maxBackoffMs` — the cost of not cancelling is at
     * most one no-op wakeup after unmount.
     */
    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    async function runStreamLoop(): Promise<void> {
      while (!cancelled) {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          await stream(
            {
              onOpen: () => {
                if (cancelled) {
                  return;
                }
                // Reset only on a *proven* connection, never on merely
                // attempting one — otherwise a server that accepts and
                // instantly drops connections would keep the backoff pinned
                // at its minimum forever.
                consecutiveFailures = 0;
                stopPolling();
                setMode("stream");
              },
              onStatus: (next) => {
                if (cancelled) {
                  return;
                }
                setStatus(next);
                setMode("stream");
              },
            },
            controller.signal,
          );
        } catch {
          // Connection refused, a non-2xx, or an abort during teardown. All
          // are handled identically: count it and back off.
        } finally {
          controllers.delete(controller);
        }

        if (cancelled) {
          return;
        }

        // Reaching here means the stream ended — whether it never opened or
        // opened and later dropped. Both are a lost connection.
        consecutiveFailures += 1;
        if (consecutiveFailures >= failuresBeforePolling) {
          startPolling();
        }

        await sleep(backoffDelayMs(consecutiveFailures, { baseMs: baseBackoffMs, maxMs: maxBackoffMs, random }));
      }
    }

    void runStreamLoop();

    return () => {
      cancelled = true;
      stopPolling();
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  return {
    // Before the first frame there is genuinely nothing to report; "disabled"
    // is the least alarming placeholder, and callers that need to tell "not
    // yet known" from "really disabled" check `status === null`.
    state: status?.state ?? "disabled",
    connected: status?.connected ?? false,
    mode,
    status,
  };
}
