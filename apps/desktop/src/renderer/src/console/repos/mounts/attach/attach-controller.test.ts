// The attach act against the fixture: two wires, one surface, and no silent no-op.
//
// DRIVEN THROUGH THE REAL CONTROLLER AND THE REAL FIXTURE BRIDGE. The scripted arms in
// `bridge/scenarios/repos/repos-mutation-replies.ts` are what a person meets on the fixture,
// so a case that stubbed the port would be asserting against a bridge no window builds.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { NODE_ID } from "../../../bridge/scenarios/repos/repos-fixture-data.js";

/** The root the scenario's healthy git mount already holds. Attaching it re-attaches. */
const ALREADY_ATTACHED_ROOT = "/Users/dev/code/ai-sidekicks";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { advanceScenarioUntil } from "../../../bridge/scenario-runtime/scenario-clock.test-support.js";
import { AttachController, useAttachController, type AttachBinding } from "./attach-controller.js";

const controllers: AttachController[] = [];

function open(): { readonly controller: AttachController; readonly clock: ManualClock } {
  const clock = new ManualClock();
  const controller = new AttachController({
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
    clock,
  });
  controllers.push(controller);
  return { controller, clock };
}

/** Move past the debounce and let the read's promises land. */
async function settleRoster(controller: AttachController, clock: ManualClock): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && controller.snapshot.prerequisite.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("AttachController — the roster read", () => {
  it("asks nothing until a participant opens the dialog", async () => {
    // The roster is read because somebody is attaching. A reconnect arriving while
    // nobody has opened the dialog changes nothing on screen.
    const { controller, clock } = open();
    controller.requestRead("reconnect");
    await settleRoster(controller, clock);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("reads the session's nodes once the dialog opens", async () => {
    const { controller, clock } = open();
    controller.requestRoster();
    await settleRoster(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(
      prerequisite.status === "read" && prerequisite.value.map((option) => option.nodeId),
    ).toContain(NODE_ID);
  });

  it("declares the runtime-node census and not this family's", () => {
    // Two readings of one answer must not disagree about when it goes stale, and what
    // changes a roster is a node frame rather than a repo one.
    const { controller } = open();
    expect(controller.triggeringEventKinds.size).toBeGreaterThan(0);
    expect(controller.triggeringEventKinds.has("repo.mount_attached")).toBe(false);
  });
});

describe("AttachController — the attach itself", () => {
  it("publishes the minted mount on the served arm", async () => {
    const { controller } = open();
    await controller.attach("/Users/dev/code/new-repo", NODE_ID);
    const { act } = controller.snapshot;
    expect(act.status).toBe("attached");
    expect(act.status === "attached" && act.response.repoMountId.length).toBeGreaterThan(0);
  });

  it("publishes the daemon's refusal rather than swallowing it", async () => {
    // The fixture refuses the already-attached root, which is the ordinary answer for
    // a person attaching the repository the session already holds.
    const { controller } = open();
    await controller.attach(ALREADY_ATTACHED_ROOT, NODE_ID);
    const { act } = controller.snapshot;
    expect(act.status).toBe("refused");
    expect(act.status === "refused" && act.refusal.code).toBe("repo.already_attached");
  });

  it("refuses to put a second attach on the wire for one intent", async () => {
    const { controller } = open();
    const first = controller.attach("/Users/dev/code/new-repo", NODE_ID);
    // The single-flight key is already taken, so the second call returns without
    // reaching the wire — where it would have refused against the first's own work.
    await controller.attach("/Users/dev/code/other-repo", NODE_ID);
    await first;
    const { act } = controller.snapshot;
    expect(act.status).toBe("attached");
  });

  it("clears the settlement without touching the roster", async () => {
    const { controller, clock } = open();
    controller.requestRoster();
    await settleRoster(controller, clock);
    await controller.attach(ALREADY_ATTACHED_ROOT, NODE_ID);
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    // Reopening the dialog must not re-read what has not changed.
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });

  it("negative control: a disposed controller publishes nothing more", async () => {
    const { controller } = open();
    const inFlight = controller.attach(ALREADY_ATTACHED_ROOT, NODE_ID);
    controller.dispose();
    await inFlight;
    expect(controller.snapshot.act.status).toBe("sending");
  });
});

/** A frame that changes a session's node roster, which is what this reading watches. */
function nodeFrame(sequence: number): ReturnType<typeof eventOfKind> {
  return eventOfKind(REPOS_SCENARIO.sessionId, "runtime_node.offline", sequence);
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** The bridge, plus how many roster reads have actually reached it. */
interface CountedRosterReads {
  readonly bridge: ConsoleBridge;
  readonly count: () => number;
}

/**
 * The real fixture bridge with its roster arm counted.
 *
 * A SPREAD OVER A REAL BRIDGE on `withDaemonCall`'s shape: the roster read is a member
 * of the bridge rather than a `daemon.call`, so that helper cannot see it, and a
 * stand-in would answer for every other arm the controller reaches too. The count is
 * the observable this whole describe rests on — a controller's identity is not one,
 * because a rebind that opened a controller and never read through it would look
 * identical from outside.
 */
function countedRosterReads(): CountedRosterReads {
  const reads: string[] = [];
  const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  const rosterRead = bridge.runtimeNodeRosterRead;
  return {
    bridge: {
      ...bridge,
      runtimeNodeRosterRead: async (request) => {
        reads.push(request.sessionId);
        return await rosterRead(request);
      },
    },
    count: () => reads.length,
  };
}

describe("useAttachController — the store is the axis the resource key cannot carry", () => {
  /** Open the dialog and wait for the roster the open asks for. */
  async function openDialog(
    bridge: ConsoleBridge,
    binding: () => AttachBinding,
    expectedReadCount: number,
    counted: () => number,
  ): Promise<void> {
    act(() => {
      binding().requestRoster();
    });
    await advanceScenarioUntil(bridge, () => {
      expect(counted()).toBe(expectedReadCount);
    });
  }

  it("mints a fresh controller when the store is rebuilt under an unchanged bridge", async () => {
    // The defect: the seam holds one controller per `(bridge, session id)`, and a
    // projection rebuilt across a reconnect carries that whole address — so the
    // controller stayed, its triggers armed on a store nothing else reads.
    const counted = countedRosterReads();
    const rendered = renderHook(
      ({ sessionStore }) => useAttachController(counted.bridge, sessionStore),
      { initialProps: { sessionStore: initialisedStore() } },
    );
    await openDialog(counted.bridge, () => rendered.result.current, 1, counted.count);

    const rebuilt = initialisedStore();
    rendered.rerender({ sessionStore: rebuilt });

    // A fresh controller has been asked nothing, where the retired one still held the
    // answer it read against the store that is gone.
    expect(rendered.result.current.reading.prerequisite.status).toBe("not-read");
    // And the retired controller's `ask` is idempotent on the question it already
    // answered, so a second open reaching it would have put NO call on the wire.
    await openDialog(counted.bridge, () => rendered.result.current, 2, counted.count);

    // The trigger half: the new store's frames reach the controller that replaced it.
    act(() => {
      rebuilt.applyBatch([nodeFrame(1)]);
    });
    await advanceScenarioUntil(counted.bridge, () => {
      expect(counted.count()).toBe(3);
    });
  });

  it("negative control: the retired store's frames reach nothing after the swap", async () => {
    // The other half of the same claim, and the one a rebind could get wrong on its
    // own: a controller replaced but never disposed would go on re-reading for a
    // session projection nothing on screen is drawn from.
    const counted = countedRosterReads();
    const retired = initialisedStore();
    const rendered = renderHook(
      ({ sessionStore }) => useAttachController(counted.bridge, sessionStore),
      { initialProps: { sessionStore: retired } },
    );
    await openDialog(counted.bridge, () => rendered.result.current, 1, counted.count);
    rendered.rerender({ sessionStore: initialisedStore() });
    await openDialog(counted.bridge, () => rendered.result.current, 2, counted.count);

    act(() => {
      retired.applyBatch([nodeFrame(1)]);
    });
    await advanceScenarioUntil(counted.bridge, () => {
      expect(rendered.result.current.reading.prerequisite.status).toBe("read");
    });

    expect(counted.count()).toBe(2);
  });

  it("negative control: a store standing still rebinds nothing", async () => {
    // Without this the two cases above would pass against a binding that re-opened a
    // controller on every render — which would lose the roster on each pass and put a
    // call on the wire for every one of them.
    const counted = countedRosterReads();
    const sessionStore = initialisedStore();
    const rendered = renderHook(
      ({ sessionStore: held }) => useAttachController(counted.bridge, held),
      { initialProps: { sessionStore } },
    );
    await openDialog(counted.bridge, () => rendered.result.current, 1, counted.count);

    rendered.rerender({ sessionStore });
    rendered.rerender({ sessionStore });

    expect(rendered.result.current.reading.prerequisite.status).toBe("read");
    expect(counted.count()).toBe(1);
  });
});
