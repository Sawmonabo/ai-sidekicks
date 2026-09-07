// The hook half of the typing producer: which line moves, and what that move means.
//
// THE PUBLISHER'S OWN SUITE CANNOT REACH ANY OF THIS. `ComposingPublisher.noteComposing`
// publishes on its FIRST call by construction, so every rule about which observation
// counts as a keystroke lives here and only here — the first observation of a restored
// draft, the move to an empty line, and the address that may not publish at all. A
// suite that drove the publisher directly would be asserting the bounds again and the
// gate not at all.
//
// DRIVEN THROUGH THE DRAFT STORE, WHICH IS WHERE A KEYSTROKE ACTUALLY LANDS. The hook
// observes one key of that store and nothing else, so writing to it is what a person
// typing IS from this module's side; a probe that passed text as a prop would be
// proving something about a prop the composer does not have.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import { crossMacrotaskBoundary } from "../../console/core/macrotask-boundary.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthServing,
  unscriptedScenario,
} from "../../console/bridge/fixture/fixture-bridge.test-support.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../console/core/index.js";
import { DraftStore } from "../../console/persistence/index.js";
import { FrameStore, SessionStore, type ConsoleEntity } from "../../console/store/index.js";
import type { GrowthPort } from "../../console/bridge/index.js";
import type { ComposerSeatProps, ConsolePaneAddress } from "../../console/seats/index.js";
import { composerDraftKey } from "./router/draft-key.js";
import { useComposingPublication } from "./use-composing-publication.js";

const SESSION_ID = "session-composing-publication";
const MAIN_CHANNEL_ID = "channel-main";
const AGENT_ID = "019b7914-0007-7000-8000-000000000007";
const RUN_ID = "019b7914-0008-7000-8000-000000000008";

/** Where the composer is addressed when the deck is showing the bootstrap channel. */
const MAIN_CHANNEL_PANE: ConsolePaneAddress = {
  kind: "timeline",
  entity: { kind: "channel", id: MAIN_CHANNEL_ID },
};

/** Where it is addressed when the deck is showing an agent with a live run. */
const AGENT_PANE: ConsolePaneAddress = {
  kind: "agent-console",
  entity: { kind: "agent", id: AGENT_ID },
};

/**
 * The two keys this suite writes under, derived rather than spelled.
 *
 * `composerDraftKey` owns the derivation and has its own suite; a literal here would
 * agree with it by discipline alone, and the day it stopped agreeing this suite would
 * write to a key the hook is not watching — and every case would pass, because
 * "nothing was published" is what most of them assert.
 */
const CHANNEL_DRAFT_KEY = composerDraftKey({
  path: "channel-message",
  sessionId: SESSION_ID,
  channelId: MAIN_CHANNEL_ID,
  workspaceId: undefined,
  channelLabel: MAIN_CHANNEL_NAME,
});
const AGENT_DRAFT_KEY = composerDraftKey({
  path: "provider-bound",
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  agentName: undefined,
  driverName: undefined,
  targetRunId: RUN_ID,
  expectedRunVersion: undefined,
  runState: "running",
  providerFailureDetail: undefined,
});

/** The port's served answer for either write, which is what the fixture's is not. */
const SERVES: GrowthPort["presenceComposingSet"] = growthServing<undefined>(undefined);

/**
 * A store holding the bootstrap channel and one agent on a run that admits a steer.
 *
 * Seeded through `initialise`, which is the door a read response comes in by, so the
 * partitions the address resolves against hold the same shape a real snapshot puts
 * there. The channel's `name` is the contract's own constant because that is the one
 * conjunct the publication gate reads, and the run's state is one that admits a steer
 * because otherwise the agent pane below would resolve to the CHANNEL path and the
 * provider-bound case would be asserting the wrong address's answer.
 */
function seededSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  const entities: readonly ConsoleEntity[] = [
    { kind: "channel", id: MAIN_CHANNEL_ID, body: { name: MAIN_CHANNEL_NAME } },
    { kind: "agent", id: AGENT_ID, body: { name: "Scout" } },
    {
      kind: "run",
      id: RUN_ID,
      state: "running",
      touchedAt: "2026-01-01T10:05:00.000Z",
      body: { agentId: AGENT_ID },
    },
  ];
  store.initialise({ cursor: 0, entities, participantJoinLog: [] });
  return store;
}

/** Renders nothing anybody reads: what this hook produces leaves through the port. */
function ComposingProbe(props: ComposerSeatProps): React.JSX.Element {
  useComposingPublication(props);
  return <p>composing probe</p>;
}

interface MountedProbe {
  readonly draftStore: DraftStore;
  readonly setCalls: Mock;
  readonly clearCalls: Mock;
  readonly container: HTMLElement;
  /**
   * Re-address the composer, which is what moving between panes does to this hook.
   *
   * The probe is re-rendered rather than re-mounted, and that distinction is the whole
   * of the re-address cases: a fresh mount has no previous observation and publishes
   * nothing by construction, so a case that re-mounted would assert the restored-draft
   * rule again under another name.
   */
  readonly reAddressTo: (focusedPane: ConsolePaneAddress) => void;
}

/** One draft already under a key before the composer ever reads it. */
interface RestoredDraft {
  readonly draftKey: string;
  readonly text: string;
}

/**
 * Mount the probe at one address over a port whose two writes this suite watches.
 *
 * `restoredDrafts` are written BEFORE the mount, which is the whole point of the
 * restored-draft case: a draft that survived a pane being closed is already under the
 * key when the composer comes back, and the first observation of it is not a keystroke.
 * A case may seed SEVERAL keys, which is what the re-address cases need: the line the
 * composer moves to has to already hold something for "the same text at two addresses"
 * to be a state at all.
 */
function mountProbe(options: {
  readonly focusedPane: ConsolePaneAddress;
  readonly restoredDrafts?: readonly RestoredDraft[];
  /** Replaces the served `presenceComposingSet`, for the refusing-port case. */
  readonly presenceComposingSet?: GrowthPort["presenceComposingSet"];
}): MountedProbe {
  const setCalls: Mock = vi.fn(options.presenceComposingSet ?? SERVES);
  const clearCalls: Mock = vi.fn(SERVES);
  const bridge = fixtureBridgeWithGrowth(unscriptedScenario("composing-publication"), {
    presenceComposingSet: setCalls,
    presenceComposingClear: clearCalls,
  });
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
    restartNoticePending: false,
  });
  for (const restored of options.restoredDrafts ?? []) {
    draftStore.write(restored.draftKey, restored.text);
  }
  // One store across every render, because a re-address moves the composer and not the
  // session: a fresh one per pass would re-seed the partitions the address resolves
  // against and hand the hook a new subject to hold its publisher under.
  const sessionStore = seededSessionStore();
  // One window store across every render, for the session store's own reason: the
  // seat's whole-workspace refusal escalates into the frame, and a fresh store per
  // pass would hand the hook a window that had never been told anything.
  const frameStore = new FrameStore();
  const probeAt = (focusedPane: ConsolePaneAddress): React.JSX.Element => (
    <ComposingProbe
      sessionStore={sessionStore}
      bridge={bridge}
      draftStore={draftStore}
      frameStore={frameStore}
      route={{ kind: "workspace", sessionId: SESSION_ID }}
      focusedPane={focusedPane}
    />
  );
  const { container, rerender } = render(probeAt(options.focusedPane));
  return {
    draftStore,
    setCalls,
    clearCalls,
    container,
    reAddressTo: (focusedPane) => {
      act(() => {
        rerender(probeAt(focusedPane));
      });
    },
  };
}

describe("useComposingPublication — the first observation is not a keystroke", () => {
  it("publishes nothing when it mounts onto a draft somebody restored", () => {
    // A composer that announced on mount would say its owner was typing every time a
    // pane was re-opened — a claim about a person who is not at the keyboard, made to
    // everybody else's roster, by a window that just came back.
    const { setCalls, clearCalls } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
      restoredDrafts: [{ draftKey: CHANNEL_DRAFT_KEY, text: "half a thought from yesterday" }],
    });

    expect(setCalls).not.toHaveBeenCalled();
    expect(clearCalls).not.toHaveBeenCalled();
  });

  it("publishes on the first move of the line, which is what a keystroke is", () => {
    // The negative control for the case above: without it a hook that published on
    // NOTHING would pass that one and be wrong about every message ever typed.
    const { draftStore, setCalls } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
      restoredDrafts: [{ draftKey: CHANNEL_DRAFT_KEY, text: "half a thought from yesterday" }],
    });

    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, "half a thought from yesterday, continued");
    });

    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveBeenCalledWith({ sessionId: SESSION_ID, channelId: MAIN_CHANNEL_ID });
  });
});

describe("useComposingPublication — a line that moved to empty", () => {
  it("clears rather than publishing, because an empty line is nobody composing", () => {
    // The send landing and the person clearing what they wrote are the same move from
    // here, and both mean the indicator comes down NOW rather than at the receiver's
    // stale bound — which is a backstop for a window that vanished, not the ordinary
    // way an indicator ends.
    const { draftStore, setCalls, clearCalls } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
    });

    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, "on its way");
    });
    expect(setCalls).toHaveBeenCalledTimes(1);

    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, "");
    });

    expect(clearCalls).toHaveBeenCalledTimes(1);
    expect(clearCalls).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(setCalls).toHaveBeenCalledTimes(1);
  });
});

describe("useComposingPublication — the composer moved to another line", () => {
  /** What both drafts read, so text equality can never be what decides these cases. */
  const SHARED_LINE = "ship it after the migration";

  it("clears the line it left, even where the line it arrives at reads the same", async () => {
    // The failure this is about is invisible in the sender's own window: the indicator
    // it leaves standing is in everybody ELSE's roster, and it comes down at the
    // receiver's stale bound rather than when its author walked away.
    const { draftStore, setCalls, clearCalls, reAddressTo } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
      restoredDrafts: [
        { draftKey: CHANNEL_DRAFT_KEY, text: "half a thought" },
        { draftKey: AGENT_DRAFT_KEY, text: SHARED_LINE },
      ],
    });
    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, SHARED_LINE);
    });
    expect(setCalls).toHaveBeenCalledTimes(1);

    reAddressTo(AGENT_PANE);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(clearCalls).toHaveBeenCalledTimes(1);
    expect(clearCalls).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(setCalls).toHaveBeenCalledTimes(1);
  });

  it("publishes for the line it arrives at, even where that line reads the same", async () => {
    // The other half of one move, and the one a text comparison silently swallowed: a
    // person who moves to a channel with a draft under it is composing THERE, and the
    // publication that says so never happened because the two strings matched.
    const { setCalls, clearCalls, reAddressTo } = mountProbe({
      focusedPane: AGENT_PANE,
      restoredDrafts: [
        { draftKey: AGENT_DRAFT_KEY, text: SHARED_LINE },
        { draftKey: CHANNEL_DRAFT_KEY, text: SHARED_LINE },
      ],
    });
    expect(setCalls).not.toHaveBeenCalled();

    reAddressTo(MAIN_CHANNEL_PANE);
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveBeenCalledWith({ sessionId: SESSION_ID, channelId: MAIN_CHANNEL_ID });
    // Nothing was outstanding to clear, and the publisher's own idempotent stop is what
    // keeps a move that publishes from also announcing a stop nobody was owed.
    expect(clearCalls).not.toHaveBeenCalled();
  });

  it("negative control: a re-render at the SAME address publishes nothing", async () => {
    // Without it, the two cases above would pass over a hook that published on every
    // commit. The pane is a structurally equal but distinct object, which is what a
    // parent re-render hands down — so what has to decide is the draft KEY the two
    // addresses resolve to, never the reference the address was carried in.
    const { draftStore, setCalls, clearCalls, reAddressTo } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
    });
    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, SHARED_LINE);
    });
    expect(setCalls).toHaveBeenCalledTimes(1);

    reAddressTo({ kind: "timeline", entity: { kind: "channel", id: MAIN_CHANNEL_ID } });
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(clearCalls).not.toHaveBeenCalled();
  });
});

describe("useComposingPublication — an address that may not publish", () => {
  it("publishes nothing for a provider-bound composer", () => {
    // A steer is addressed to one agent's run and is nobody else's room to watch, so
    // the target supplies neither conjunct the gate reads and the hook is fail-closed
    // by construction rather than by a branch that could be forgotten.
    const { draftStore, setCalls, clearCalls } = mountProbe({
      focusedPane: AGENT_PANE,
    });

    act(() => {
      draftStore.write(AGENT_DRAFT_KEY, "stop and check the migration first");
    });

    expect(setCalls).not.toHaveBeenCalled();
    expect(clearCalls).not.toHaveBeenCalled();
  });

  it("says nothing to the person when the port refuses, and stops asking", async () => {
    // A composing indicator is an ambient courtesy and a person mid-sentence is the
    // worst possible audience for a message about a wire that has not been built yet.
    // So the composer renders on — and the publisher is retired, which is the half a
    // "nothing was surfaced" assertion cannot see on its own: without it a refusing
    // port would take one call per keystroke for the length of every message.
    const refusingSet: GrowthPort["presenceComposingSet"] = async () => {
      await Promise.resolve();
      throw new Error("the presence wire is not built");
    };
    const { draftStore, setCalls, container } = mountProbe({
      focusedPane: MAIN_CHANNEL_PANE,
      presenceComposingSet: refusingSet,
    });

    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, "first");
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      draftStore.write(CHANNEL_DRAFT_KEY, "first and second");
    });

    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("composing probe");
  });
});
