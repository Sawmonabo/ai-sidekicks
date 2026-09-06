// The attach act against the fixture: two wires, one surface, and no silent no-op.
//
// DRIVEN THROUGH THE REAL CONTROLLER AND THE REAL FIXTURE BRIDGE. The scripted arms in
// `bridge/scenarios/repos-mutation-replies.ts` are what a person meets on the fixture,
// so a case that stubbed the port would be asserting against a bridge no window builds.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { NODE_ID } from "../../../bridge/scenarios/repos-fixture-data.js";

/** The root the scenario's healthy git mount already holds. Attaching it re-attaches. */
const ALREADY_ATTACHED_ROOT = "/Users/dev/code/ai-sidekicks";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { AttachController } from "./attach-controller.js";

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
