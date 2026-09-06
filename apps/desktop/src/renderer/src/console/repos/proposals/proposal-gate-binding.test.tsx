// What makes the binding mint a new gate reader, and what deliberately does not.
//
// THE MEMO KEYS ON THE SUBJECT'S PARTS AND NEVER ON THE SUBJECT, because every caller
// composes one inline — a mount card builds one per worktree row on every render — so a
// memo keyed on the object would mint a reader, and a read, on every frame. That makes
// the dependency list a claim about the union's content, and a claim a case can put:
// change one member and the reader is rebuilt; change nothing and it is not.
//
// A READ IS THE OBSERVABLE, because reader identity is not one. Each reader starts by
// reading the branch context through the growth port, so counting calls to
// `growth.gitflowBranchContextRead` counts readers that were actually built and
// started. The fixture bridge answers underneath, so the count is the only thing this
// file changes about it — and the scenario's frozen clock is what the debounce arms on,
// which is why a case drives time rather than polling it.

import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { SessionStore } from "../../store/index.js";
import { repeatedDisposalCount } from "../resource-seam.test-support.js";
import { advanceScenarioUntil } from "../scenario-clock.test-support.js";
import { useProposalGate } from "./proposal-gate-binding.js";
import { ProposalGateReader } from "./proposal-gate-reader.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";

/** One worktree gate's subject, spelled here so a case can move exactly one member. */
const WORKTREE_SUBJECT: ProposalGateSubject = {
  kind: "worktree",
  workspaceId: "workspace-git",
  repoMountId: "mount-alpha",
  worktreeId: "worktree-implementer",
  executionMode: "worktree",
};

/** The hook under a rerenderable subject, and the read count the bridge has seen. */
interface BindingUnderTest {
  readonly rerenderWith: (subject: ProposalGateSubject) => void;
  /** Drive scenario time until the read count reaches `expected`, then assert it. */
  readonly expectReadsToReach: (expected: number) => Promise<void>;
  readonly readCount: () => number;
  readonly unmount: () => void;
}

function renderBinding(
  subject: ProposalGateSubject,
  options: { readonly strict?: boolean } = {},
): BindingUnderTest {
  const answering = createFixtureBridge({ scenario: REPOS_SCENARIO });
  let reads = 0;
  const bridge: ConsoleBridge = {
    ...answering,
    growth: {
      ...answering.growth,
      gitflowBranchContextRead: async (request) => {
        reads += 1;
        return await answering.growth.gitflowBranchContextRead(request);
      },
    },
  };
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  const readCount = (): number => reads;
  const { rerender, unmount } = renderHook(
    (props: { readonly subject: ProposalGateSubject }) =>
      useProposalGate(bridge, props.subject, sessionStore),
    {
      initialProps: { subject },
      ...(options.strict === true ? { wrapper: StrictMode } : {}),
    },
  );
  return {
    rerenderWith: (next) => {
      rerender({ subject: next });
    },
    expectReadsToReach: async (expected) => {
      await advanceScenarioUntil(bridge, () => {
        expect(readCount()).toBe(expected);
      });
    },
    readCount,
    unmount,
  };
}

describe("useProposalGate — the subject's parts are the memo's key", () => {
  it("rebuilds the reader when the repo mount moves and nothing else does", async () => {
    // `repoMountId` is not what the gate READS under, which is why it was missing from
    // the list — but it is the only identity the registered act request takes, so a
    // reader holding a stale one would send an act naming a mount the surface has
    // moved off.
    const binding = renderBinding(WORKTREE_SUBJECT);
    await binding.expectReadsToReach(1);

    binding.rerenderWith({ ...WORKTREE_SUBJECT, repoMountId: "mount-beta" });

    await binding.expectReadsToReach(2);
  });

  it("negative control: a fresh subject object with the same five members rebuilds nothing", async () => {
    // Without this the case above would pass against a memo keyed on the subject
    // itself, which every caller replaces on every render — a new reader and a new
    // read per frame, which is the reason the list names parts at all.
    const binding = renderBinding(WORKTREE_SUBJECT);
    await binding.expectReadsToReach(1);

    binding.rerenderWith({ ...WORKTREE_SUBJECT });
    binding.rerenderWith({ ...WORKTREE_SUBJECT });

    await binding.expectReadsToReach(1);
    expect(binding.readCount()).toBe(1);
  });
});

describe("useProposalGate — the reader is a resource, not a memo", () => {
  it("reads under StrictMode, where a memoised reader was disposed and never restarted", async () => {
    // The bug, exercised: the cleanup disposed terminally and the replayed setup called
    // `start()` on the corpse, so a gate row sat unread in development — the one
    // environment where the console's budgets are being watched. The re-mint arm is
    // what makes the replay reach a live reader.
    const binding = renderBinding(WORKTREE_SUBJECT, { strict: true });

    await binding.expectReadsToReach(1);

    expect(binding.readCount()).toBe(1);
  });

  it("negative control: StrictMode's replay opens exactly one reader, not one per render", async () => {
    // Without this the case above would pass against a binding that opened a reader on
    // every pass — the leak the memo existed to prevent, dressed as a fix for the one
    // it caused.
    const binding = renderBinding(WORKTREE_SUBJECT, { strict: true });
    await binding.expectReadsToReach(1);

    binding.rerenderWith({ ...WORKTREE_SUBJECT });
    binding.rerenderWith({ ...WORKTREE_SUBJECT });

    await binding.expectReadsToReach(1);
    expect(binding.readCount()).toBe(1);
  });

  it("disposes every reader it opened exactly once", async () => {
    // `useRepoMounts`'s case, one directory over, and the same seam argument: the
    // disposal is TERMINAL and the seam is told so through `isClosed`. Re-derived in
    // this binding's own effect, the corpse StrictMode's replay produced was recorded
    // as committed and disposed a second time when the published replacement retired
    // it. `dispose` is re-entrant here, so the CALL is what is counted.
    const disposals = vi.spyOn(ProposalGateReader.prototype, "dispose");
    try {
      const binding = renderBinding(WORKTREE_SUBJECT, { strict: true });
      await binding.expectReadsToReach(1);
      binding.unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // Negative control on the count: a spy that saw nothing reports zero repeats.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});
