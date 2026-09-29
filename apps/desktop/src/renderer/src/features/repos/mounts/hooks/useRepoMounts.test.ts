// What holds the section's reader, and what happens to it on the renders React throws
// away and replays.
//
// A `useMemo` HELD IT, AND A MEMO IS NOT A RESOURCE SEAM. Two things follow from that,
// and both are about renders rather than about reads. A memo opened during a pass React
// then DISCARDS really built the reader and really armed its refresh, and no effect ever
// committed to close it — so the pass leaks a scheduler and a store subscription that
// nothing can reach. And strict mode's double-mount runs the cleanup and then the same
// setup again on the SAME memoized reader: `dispose` is terminal, so the replayed
// `start()` returned early and the section sat unread, with nothing on screen to say
// why. `useSubjectScopedResource` answers the first; the binding's re-mint arm answers
// the second, on `useStagedAttachments`'s pattern.
//
// A WORKSPACE-LIST READ IS THE OBSERVABLE, because reader identity is not one: the list
// is the first call every started reader makes, so counting it counts readers that were
// built AND started, which is the pair the seam is being asked about.

import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
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
  const bridge = bridgeOnClock("repos", clock);
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
  const { result, rerender, unmount } = renderHook(
    () => useRepoMounts(bridge, sessionStore, operations),
    { ...(options.strict ? { wrapper: StrictMode } : {}) },
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
    // The bug, exercised: the cleanup disposed terminally and the replayed setup called
    // `start()` on the corpse, so this section never left `not-read` in development —
    // the one environment where the budgets are being watched.
    const binding = renderBinding({ strict: true });

    await binding.settle();

    expect(binding.binding().reading.mounts.length).toBeGreaterThan(0);
  });

  it("negative control: a re-mint is once, not once per render", async () => {
    // Without this the case above would pass against a binding that opened a reader on
    // every pass — the leak the memo existed to prevent, dressed as a fix for the one
    // it caused. Exactly one reader ever reaches the wire, StrictMode's replay
    // included.
    const binding = renderBinding({ strict: true });
    await binding.settle();
    expect(binding.listReadCount()).toBe(1);

    binding.rerender();
    binding.rerender();
    await binding.settle();

    expect(binding.listReadCount()).toBe(1);
  });

  it("negative control: outside StrictMode the same binding reads exactly once too", async () => {
    // The re-mint arm must not fire where nothing was disposed: a binding that minted a
    // second reader on an ordinary commit would double every read this section makes
    // while both cases above stayed green.
    const binding = renderBinding({ strict: false });

    await binding.settle();

    expect(binding.listReadCount()).toBe(1);
  });

  it("disposes every reader it opened exactly once", async () => {
    // The seam is told the disposal is TERMINAL, through `isClosed`. Re-derived in the
    // binding's own effect instead, the corpse StrictMode's replay produced was
    // recorded as committed, the binding published a replacement, and the
    // value-change cleanup disposed that corpse a second time. `dispose` here is
    // re-entrant, so nothing broke and nothing could fail — which is why the call is
    // counted rather than its effect.
    const disposals = vi.spyOn(RepoMountsReader.prototype, "dispose");
    try {
      const binding = renderBinding({ strict: true });
      await binding.settle();
      binding.unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // Negative control on the count itself: a spy that saw nothing would report zero
      // repeats for a binding that had stopped disposing readers at all.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});

describe("useRepoMounts — the calls are part of what the reader is keyed on", () => {
  it("reads through the new calls when the section is handed a different set", async () => {
    const clock = new ManualClock();
    const bridge = bridgeOnClock("repos", clock);
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
      { initialProps: { operations: first } },
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
