// What holds the section's reader, and what happens to it on the renders React throws
// away and replays.
//
// A `useMemo` HELD IT, AND A MEMO IS NOT A RESOURCE SEAM. Two things follow from that,
// and both are about renders rather than about reads. A memo opened during a pass React
// then DISCARDS really built the reader and really armed its refresh, and no effect ever
// committed to close it — so the pass leaks a scheduler and a store subscription that
// nothing can reach. And strict mode's double-mount runs the cleanup and then the same
// setup again on the SAME memoised reader: `dispose` is terminal, so the replayed
// `start()` returned early and the section sat unread, with nothing on screen to say
// why. `useSubjectScopedResource` answers the first; the binding's re-mint arm answers
// the second, on `useAttachmentCarrier`'s pattern.
//
// A ROSTER READ IS THE OBSERVABLE, because reader identity is not one: `repo.workspaceList`
// is the first call every started reader makes, so counting it counts readers that were
// built AND started, which is the pair the seam is being asked about.

import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { SessionStore } from "../../store/index.js";
import { advanceScenarioUntil } from "../scenario-clock.test-support.js";
import { useRepoMounts, type RepoMountsBinding } from "./repo-mounts-binding.js";

const WORKSPACE_LIST_CALL = "repo.workspaceList";

/** The hook under a wrapper, with the roster reads the bridge has actually seen. */
interface BindingUnderTest {
  readonly binding: () => RepoMountsBinding;
  readonly rerender: () => void;
  readonly rosterReadCount: () => number;
  readonly settle: () => Promise<void>;
}

function renderBinding(options: { readonly strict: boolean }): BindingUnderTest {
  const held = withDaemonCall(
    createFixtureBridge({ scenario: REPOS_SCENARIO }),
    async (_call, passThrough) => await passThrough(),
  );
  const bridge: ConsoleBridge = held.bridge;
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const { result, rerender } = renderHook(() => useRepoMounts(bridge, sessionStore), {
    ...(options.strict ? { wrapper: StrictMode } : {}),
  });
  return {
    binding: () => result.current,
    rerender: () => {
      rerender();
    },
    rosterReadCount: () => held.calls.filter((call) => call.method === WORKSPACE_LIST_CALL).length,
    settle: async () => {
      await advanceScenarioUntil(bridge, () => {
        expect(result.current.reading.status).toBe("read");
      });
    },
  };
}

describe("useRepoMounts — the reader is a resource, not a memo", () => {
  it("reads under StrictMode, where a memoised reader was disposed and never restarted", async () => {
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
    expect(binding.rosterReadCount()).toBe(1);

    binding.rerender();
    binding.rerender();
    await binding.settle();

    expect(binding.rosterReadCount()).toBe(1);
  });

  it("negative control: outside StrictMode the same binding reads exactly once too", async () => {
    // The re-mint arm must not fire where nothing was disposed: a binding that minted a
    // second reader on an ordinary commit would double every read this section makes
    // while both cases above stayed green.
    const binding = renderBinding({ strict: false });

    await binding.settle();

    expect(binding.rosterReadCount()).toBe(1);
  });
});
