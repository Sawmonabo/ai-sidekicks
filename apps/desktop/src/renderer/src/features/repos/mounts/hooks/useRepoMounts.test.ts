// What holds the section's reader, and what happens to it on renders React discards and
// replays. A memo is not a resource seam: a discarded pass would leak a started reader, and
// StrictMode's replayed setup would call `start()` on a disposed one. The observable is the
// workspace-list read, the first call every started reader makes.

import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { repeatedDisposalCount } from "@test/helpers/repeated-disposal.js";
import { useRepoMounts, type RepoMountsBinding } from "./useRepoMounts.js";
import { RepoMountsReader } from "../repo-mounts-reader.js";
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
    // The cleanup disposed terminally and the replayed setup called `start()` on the disposed
    // reader, so the section never left `not-read` in development.
    const binding = renderBinding({ strict: true });

    await binding.settle();

    expect(binding.binding().reading.mounts.length).toBeGreaterThan(0);
  });

  it("negative control: a re-mint is once, not once per render", async () => {
    // Without this the case above would pass against a binding that opened a reader on every
    // pass. Exactly one reader reaches the wire, StrictMode's replay included.
    const binding = renderBinding({ strict: true });
    await binding.settle();
    expect(binding.listReadCount()).toBe(1);

    binding.rerender();
    binding.rerender();
    await binding.settle();

    expect(binding.listReadCount()).toBe(1);
  });

  it("negative control: outside StrictMode the same binding reads exactly once too", async () => {
    // The re-mint arm must not fire where nothing was disposed: a second reader on an ordinary
    // commit would double every read.
    const binding = renderBinding({ strict: false });

    await binding.settle();

    expect(binding.listReadCount()).toBe(1);
  });

  it("disposes every reader it opened exactly once", async () => {
    // Disposal is terminal and reported through `isClosed`. Re-derived in the binding's effect,
    // StrictMode's corpse was disposed twice; `dispose` is re-entrant so nothing failed, which is
    // why the call is counted rather than its effect.
    const disposals = vi.spyOn(RepoMountsReader.prototype, "dispose");
    try {
      const binding = renderBinding({ strict: true });
      await binding.settle();
      binding.unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // A spy that saw nothing would report zero repeats for a binding that never disposed.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
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
