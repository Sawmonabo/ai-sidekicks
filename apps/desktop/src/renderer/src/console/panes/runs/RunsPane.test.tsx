// The pane itself: its three absences, the runs the session knows about, and its
// registration.
//
// The seat's own claims. An empty list, an unread list, and a stream that could not
// be opened are three different sentences, and every run the session knows has a row
// — including the ones that are no longer live, which say so rather than vanishing.

import { describe, expect, it } from "vitest";
import { ConsolePaneRegistry } from "../../seats/index.js";
import { isDetachablePaneKind } from "../../seats/pane-kinds.js";
import { registerRunsPane } from "./index.js";
import {
  RUN_ID,
  SECOND_RUN_ID,
  THIRD_RUN_ID,
  renderPane,
  scriptedBridge,
  transition,
} from "./runs-pane.test-support.js";

describe("the runs pane's three absences", () => {
  it("says so when it was opened outside a session", async () => {
    const container = await renderPane(scriptedBridge([]), false);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("shows a read in flight before the session's snapshot has landed, never an empty session", async () => {
    // `not-loaded` and `empty` are different facts: one says the console is
    // asking, the other says there is nothing. Conflating them would report a
    // session with no runs before the read that enumerates them completed.
    const container = await renderPane(scriptedBridge([]), true);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says the session has no runs once its snapshot lands naming none", async () => {
    // The arm the old rule could not reach at all: `hasRead` only ever flipped on a
    // projected run, so a session with no runs read "Reading the runs" forever.
    const container = await renderPane(scriptedBridge([]), true, (store) => {
      store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    });
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("draws a row for a run the snapshot names and the stream has not described", async () => {
    // Read complete, stream silent, and the session is known to have a run — so
    // neither "there are none" nor a skeleton is the honest shape. The run has a
    // row, seated from the session's own record.
    const container = await renderPane(scriptedBridge([]), true, (store) => {
      store.initialise({
        cursor: 4,
        entities: [{ kind: "run", id: RUN_ID, state: "running" }],
        participantJoinLog: [],
      });
    });
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelectorAll(".meridian-known-run")).toHaveLength(1);
  });

  it("negative control: a delivered run replaces the skeleton with a row", async () => {
    // Without this the case above would pass over a pane that rendered a skeleton
    // forever whatever the stream said.
    const container = await renderPane(scriptedBridge([transition("queued", "running", 2)]), true);
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.textContent).toContain(RUN_ID);
  });
});

describe("every run the session knows has a row, and the ones that are not live say so", () => {
  it("seats three known runs beside one streamed projection and marks the two pending", async () => {
    const container = await renderPane(
      scriptedBridge([transition("queued", "running", 2)]),
      true,
      (store) => {
        store.initialise({
          cursor: 9,
          entities: [
            { kind: "run", id: RUN_ID, state: "running" },
            { kind: "run", id: SECOND_RUN_ID, state: "completed" },
            { kind: "run", id: THIRD_RUN_ID, state: "failed" },
          ],
          participantJoinLog: [],
        });
      },
    );
    // Three rows for three runs: one live, two from the session's own record.
    expect(container.querySelectorAll(".meridian-ledger-row")).toHaveLength(1);
    expect(container.querySelectorAll(".meridian-known-run")).toHaveLength(2);
  });

  it("names how many runs are not live and which they are", async () => {
    const container = await renderPane(
      scriptedBridge([transition("queued", "running", 2)]),
      true,
      (store) => {
        store.initialise({
          cursor: 9,
          entities: [
            { kind: "run", id: RUN_ID, state: "running" },
            { kind: "run", id: SECOND_RUN_ID, state: "completed" },
            { kind: "run", id: THIRD_RUN_ID, state: "failed" },
          ],
          participantJoinLog: [],
        });
      },
    );
    const sentence = container.querySelector(".meridian-runs__awaiting-projection");
    expect(sentence?.textContent).toContain("2 runs");
    expect(sentence?.textContent).toContain(SECOND_RUN_ID);
    expect(sentence?.textContent).toContain(THIRD_RUN_ID);
    // The one the stream described is not named as missing a live reading.
    expect(sentence?.textContent).not.toContain(RUN_ID);
  });

  it("renders a terminal pre-existing run from the record's own facts, never a skeleton", async () => {
    // The stream is a tail with no replay, so a run that stopped before the pane
    // opened produces no delivery ever. Its terminal is on the session's record.
    const container = await renderPane(scriptedBridge([]), true, (store) => {
      store.initialise({
        cursor: 12,
        entities: [
          {
            kind: "run",
            id: SECOND_RUN_ID,
            state: "failed",
            touchedAt: "2026-01-01T15:00:00.000Z",
            body: {
              runVersion: 8,
              trigger: "budget_exhausted",
              failureCategory: "provider_error",
            },
          },
        ],
        participantJoinLog: [],
      });
    });
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("v8");
    expect(container.textContent).toContain("the run exhausted its budget");
    expect(container.textContent).toContain("provider_error");
  });

  it("says nothing about missing readings once every known run has a projection", async () => {
    const container = await renderPane(
      scriptedBridge([transition("queued", "running", 2)]),
      true,
      (store) => {
        store.initialise({
          cursor: 4,
          entities: [{ kind: "run", id: RUN_ID, state: "running" }],
          participantJoinLog: [],
        });
      },
    );
    expect(container.querySelector(".meridian-runs__awaiting-projection")).toBeNull();
    expect(container.querySelector(".meridian-known-run")).toBeNull();
    expect(container.querySelectorAll(".meridian-ledger-row")).toHaveLength(1);
  });

  it("negative control: the first streamed run alone still renders as one live row", async () => {
    // Without this the cases above would pass over a pane that had stopped reading
    // the stream at all and seated every row from the partition.
    const container = await renderPane(scriptedBridge([transition("queued", "running", 2)]), true);
    expect(container.querySelectorAll(".meridian-ledger-row")).toHaveLength(1);
    expect(container.querySelector(".meridian-known-run")).toBeNull();
    expect(container.querySelector(".meridian-runs__awaiting-projection")).toBeNull();
  });
});

describe("the pane's registration", () => {
  it("claims the runs kind through the registry's one door, and no tear-off with it", () => {
    const registry = new ConsolePaneRegistry();
    registerRunsPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["runs"]);
    // Whether a kind may be torn off is the window model's answer and never a
    // claim on the descriptor, so the registration asserts the body and the
    // predicate asserts the window.
    expect(isDetachablePaneKind("runs")).toBe(false);
  });

  it("negative control: a registry nobody registered into claims nothing", () => {
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
