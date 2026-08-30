/**
 * Tests for the resilient status hook.
 *
 * The scenario that matters most is the full degradation-and-recovery cycle:
 * SSE fails repeatedly, the hook falls back to polling, SSE later comes back,
 * and polling stops so the live stream takes over again. That sequence is the
 * whole reason the hook exists, and it is exactly the sort of behaviour that
 * is never noticed as broken in manual testing — a badge that quietly froze
 * on a stale value looks identical to one that is correct.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiHardwareStatus, type HardwareStreamHandlers } from "../api";
import { backoffDelayMs, useHardwareStatus } from "./useHardwareStatus";

function statusFixture(overrides: Partial<ApiHardwareStatus> = {}): ApiHardwareStatus {
  return {
    state: "connected",
    connected: true,
    port_path: "COM5",
    last_ack_at: "2026-01-01T00:00:00.000Z",
    last_error: null,
    last_command: null,
    ...overrides,
  };
}

/**
 * A controllable stand-in for `streamHardwareStatus`.
 *
 * `fail()` makes every subsequent connection attempt reject, as an
 * unreachable backend would; `goLive()` makes them connect and stay open,
 * with `push()` delivering frames on the newest connection.
 */
function makeStreamFake() {
  let behaviour: "fail" | "live" = "fail";
  const open: Array<{ handlers: HardwareStreamHandlers; resolve: () => void }> = [];

  const fn = vi.fn(async (handlers: HardwareStreamHandlers, signal?: AbortSignal): Promise<void> => {
    if (behaviour === "fail") {
      throw new ApiError(0, "Could not reach the server");
    }
    handlers.onOpen?.();
    await new Promise<void>((resolve) => {
      open.push({ handlers, resolve });
      signal?.addEventListener("abort", () => {
        resolve();
      });
    });
  });

  return {
    fn,
    fail(): void {
      behaviour = "fail";
    },
    goLive(): void {
      behaviour = "live";
    },
    /** Drops every currently open connection, as a server restart would. */
    dropOpen(): void {
      for (const connection of open.splice(0)) {
        connection.resolve();
      }
    },
    push(status: ApiHardwareStatus): void {
      open.at(-1)?.handlers.onStatus(status);
    },
    get openCount(): number {
      return open.length;
    },
  };
}

/** Options tuned so the whole backoff/fallback cycle runs in milliseconds, with no jitter randomness. */
const fastOptions = {
  baseBackoffMs: 2,
  maxBackoffMs: 8,
  failuresBeforePolling: 3,
  pollIntervalMs: 5,
  random: () => 0.5,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffDelayMs", () => {
  const options = { baseMs: 1000, maxMs: 30_000, random: () => 0.5 };

  it("doubles on each consecutive failure", () => {
    expect(backoffDelayMs(1, options)).toBe(1000);
    expect(backoffDelayMs(2, options)).toBe(2000);
    expect(backoffDelayMs(3, options)).toBe(4000);
    expect(backoffDelayMs(4, options)).toBe(8000);
  });

  it("caps at the configured maximum instead of growing without bound", () => {
    expect(backoffDelayMs(20, options)).toBe(30_000);
  });

  it("applies jitter within +/-25%, so reconnecting tabs do not retry in lockstep", () => {
    expect(backoffDelayMs(1, { ...options, random: () => 0 })).toBe(750);
    expect(backoffDelayMs(1, { ...options, random: () => 1 })).toBe(1250);
  });
});

describe("useHardwareStatus", () => {
  it("renders frames from a healthy stream", async () => {
    const stream = makeStreamFake();
    stream.goLive();
    const poll = vi.fn(async () => statusFixture());

    const { result } = renderHook(() => useHardwareStatus({ ...fastOptions, stream: stream.fn, poll }));

    await waitFor(() => {
      expect(stream.openCount).toBe(1);
    });
    act(() => {
      stream.push(statusFixture({ state: "connected" }));
    });

    await waitFor(() => {
      expect(result.current.state).toBe("connected");
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.mode).toBe("stream");
    // A working stream must never trigger the polling fallback.
    expect(poll).not.toHaveBeenCalled();
  });

  it("reports nothing known before the first frame arrives", () => {
    const stream = makeStreamFake();
    stream.goLive();
    const { result } = renderHook(() =>
      useHardwareStatus({ ...fastOptions, stream: stream.fn, poll: vi.fn(async () => statusFixture()) }),
    );

    expect(result.current.status).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it("keeps `connected` consistent with `state` in every frame it renders", async () => {
    const stream = makeStreamFake();
    stream.goLive();
    const { result } = renderHook(() =>
      useHardwareStatus({ ...fastOptions, stream: stream.fn, poll: vi.fn(async () => statusFixture()) }),
    );
    await waitFor(() => {
      expect(stream.openCount).toBe(1);
    });

    act(() => {
      stream.push(statusFixture({ state: "probing", connected: false }));
    });
    await waitFor(() => {
      expect(result.current.state).toBe("probing");
    });
    // `probing` is a healthy heartbeat, not a disconnect — the hook passes it
    // through untouched and lets the badge decide how to present it.
    expect(result.current.connected).toBe(false);
  });

  it("falls back to polling after repeated stream failures, then resumes streaming once SSE recovers", async () => {
    const stream = makeStreamFake();
    stream.fail();
    const poll = vi.fn(async () => statusFixture({ state: "scanning", connected: false, port_path: null }));

    const { result } = renderHook(() => useHardwareStatus({ ...fastOptions, stream: stream.fn, poll }));

    // 1. SSE keeps failing, so the hook falls back to polling and the badge
    //    starts updating again instead of sitting frozen.
    await waitFor(() => {
      expect(result.current.mode).toBe("poll");
    });
    expect(result.current.state).toBe("scanning");
    expect(stream.fn.mock.calls.length).toBeGreaterThanOrEqual(fastOptions.failuresBeforePolling);

    // 2. SSE keeps being retried in the background while polling continues.
    const attemptsAtFallback = stream.fn.mock.calls.length;
    await waitFor(() => {
      expect(stream.fn.mock.calls.length).toBeGreaterThan(attemptsAtFallback);
    });

    // 3. The backend comes back. The next retry connects.
    stream.goLive();
    await waitFor(() => {
      expect(result.current.mode).toBe("stream");
    });

    act(() => {
      stream.push(statusFixture({ state: "connected" }));
    });
    await waitFor(() => {
      expect(result.current.state).toBe("connected");
    });

    // 4. Polling has genuinely stopped — not merely been superseded in the
    //    rendered value while a timer keeps firing in the background.
    const pollsAtRecovery = poll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, fastOptions.pollIntervalMs * 4));
    expect(poll.mock.calls.length).toBe(pollsAtRecovery);
    expect(result.current.mode).toBe("stream");
  });

  it("reports `lost` when neither the stream nor polling can reach the backend", async () => {
    const stream = makeStreamFake();
    stream.fail();
    const poll = vi.fn(async () => {
      throw new ApiError(0, "Could not reach the server");
    });

    const { result } = renderHook(() => useHardwareStatus({ ...fastOptions, stream: stream.fn, poll }));

    await waitFor(() => {
      expect(result.current.mode).toBe("lost");
    });
    // Honest about not knowing, rather than presenting a stale value as live.
    expect(result.current.status).toBeNull();
  });

  it("recovers from `lost` back to streaming when the backend returns", async () => {
    const stream = makeStreamFake();
    stream.fail();
    let pollWorks = false;
    const poll = vi.fn(async () => {
      if (!pollWorks) {
        throw new ApiError(0, "Could not reach the server");
      }
      return statusFixture();
    });

    const { result } = renderHook(() => useHardwareStatus({ ...fastOptions, stream: stream.fn, poll }));
    await waitFor(() => {
      expect(result.current.mode).toBe("lost");
    });

    pollWorks = true;
    stream.goLive();
    await waitFor(() => {
      expect(result.current.mode).toBe("stream");
    });
  });

  it("treats a stream that opens and then drops as a disconnect and reconnects", async () => {
    const stream = makeStreamFake();
    stream.goLive();
    const { result } = renderHook(() =>
      useHardwareStatus({ ...fastOptions, stream: stream.fn, poll: vi.fn(async () => statusFixture()) }),
    );

    await waitFor(() => {
      expect(stream.openCount).toBe(1);
    });
    const attemptsBefore = stream.fn.mock.calls.length;

    act(() => {
      stream.dropOpen();
    });

    await waitFor(() => {
      expect(stream.fn.mock.calls.length).toBeGreaterThan(attemptsBefore);
    });
    expect(result.current.mode).toBe("stream");
  });

  it("aborts its connection and stops all work on unmount", async () => {
    const stream = makeStreamFake();
    stream.goLive();
    const poll = vi.fn(async () => statusFixture());

    const { unmount } = renderHook(() => useHardwareStatus({ ...fastOptions, stream: stream.fn, poll }));
    await waitFor(() => {
      expect(stream.openCount).toBe(1);
    });

    unmount();

    const attemptsAtUnmount = stream.fn.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // No reconnect loop left spinning behind an unmounted component.
    expect(stream.fn.mock.calls.length).toBe(attemptsAtUnmount);
    expect(poll).not.toHaveBeenCalled();
  });
});
