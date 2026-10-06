// What holds the section's reader, and what happens to it on renders React discards and
// re-runs. A memo is not a resource seam: a discarded pass would leak a started reader, and
// StrictMode's re-run setup would call `start()` on a disposed one. The observable is the
// workspace-list read, the first call every started reader makes.

import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { SessionStore } from "#renderer/store/session/store.js";
import type { RepoOperations } from "../../operations.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { useRepoMounts, type RepoMountsBinding } from "./useRepoMounts.js";
import { SESSION_ID, sessionOperations } from "../repo-mounts.test-support.js";

/** The hook under a wrapper, with the workspace-list reads the daemon has actually seen. */
interface BindingUnderTest {
  readonly binding: () => RepoMountsBinding;
  readonly rerender: () => void;
  readonly listReadCount: () => number;
  readonly settle: () => Promise<void>;
  readonly unmount: () => void;
}

function renderBinding(options: { readonly strict: boolean }): BindingUnderTest {
  const clock = new ManualClock();
  const { bridge } = bridgeOnClock("repos", clock);
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  const base = sessionOperations();
  let listReads = 0;
  const operations = {
    ...base,
    listWorkspaces: (sessionId: string, signal: AbortSignal) => {
      listReads += 1;
      return base.listWorkspaces(sessionId, signal);
    },
  };
  const BridgeHost = bridgeWrapper(bridge, clock);
  const { result, rerender, unmount } = renderHook(
    () => useRepoMounts(bridge, sessionStore, operations),
    {
      wrapper: options.strict
        ? ({ children }: { readonly children: ReactNode }) =>
            createElement(StrictMode, null, createElement(BridgeHost, { children }))
        : BridgeHost,
    },
  );
  return {
    binding: () => result.current,
    rerender: () => {
      rerender();
    },
    listReadCount: () => listReads,
    settle: async () => {
      await crossMacrotaskBoundary();
      act(() => {
        clock.advance(REFRESH_DEBOUNCE_MS);
      });
      await waitFor(() => {
        expect(result.current.reading.status).toBe("read");
      });
    },
    unmount,
  };
}

describe("useRepoMounts — the reader is a resource, not a memo", () => {
  it("reads under StrictMode, where a memoized reader was disposed, never restarted", async () => {
    // The cleanup disposed terminally and the re-run setup called `start()` on the disposed
    // reader, so the section never left `not-read` in development.
    const binding = renderBinding({ strict: true });

    await binding.settle();

    expect(binding.binding().reading.mounts.length).toBeGreaterThan(0);
  });

  it("re-mints once, not once per render", async () => {
    // A binding that opened a reader on every pass would double every read. Exactly one reader
    // reaches the wire, StrictMode's re-run included.
    const binding = renderBinding({ strict: true });
    await binding.settle();
    expect(binding.listReadCount()).toBe(1);

    binding.rerender();
    binding.rerender();
    await binding.settle();

    expect(binding.listReadCount()).toBe(1);
  });
});

describe("useRepoMounts — the calls are part of what the reader is keyed on", () => {
  it("reads through the new calls when the section is handed a different set", async () => {
    const clock = new ManualClock();
    const { bridge } = bridgeOnClock("repos", clock);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const listReads = { first: 0, second: 0 };
    const countingOperations = (which: "first" | "second"): RepoOperations => {
      const base = sessionOperations();
      return {
        ...base,
        listWorkspaces: (sessionId, signal) => {
          listReads[which] += 1;
          return base.listWorkspaces(sessionId, signal);
        },
      };
    };
    const first = countingOperations("first");
    const second = countingOperations("second");
    const { result, rerender } = renderHook(
      ({ operations }) => useRepoMounts(bridge, sessionStore, operations),
      { initialProps: { operations: first }, wrapper: bridgeWrapper(bridge, clock) },
    );
    await crossMacrotaskBoundary();
    act(() => {
      clock.advance(REFRESH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(result.current.reading.status).toBe("read");
    });

    rerender({ operations: second });
    await crossMacrotaskBoundary();
    act(() => {
      clock.advance(REFRESH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(listReads.second).toBe(1);
    });

    expect(listReads.first).toBe(1);
  });
});
