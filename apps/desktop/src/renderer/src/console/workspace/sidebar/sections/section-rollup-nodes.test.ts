// The two seams this family's sections report through, driven directly.
//
// THE REAL `SessionStore`, for the reason both section suites give: the guard here is
// written over three distinct STORE states — uninitialised, initialised-and-degraded,
// initialised-and-whole — and a hand-made snapshot would let all three pass while the
// real store put a section in a fourth.
//
// The drag half is driven through a RECORDING BINDER rather than through a rendered
// row, because what this module owns about a drag is the target it composes: the
// gesture itself is `drag/row-drag.ts`'s, and the element adapter cannot be driven in
// this tier at all — jsdom implements neither `DragEvent` nor `DataTransfer`.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenarios/composer.js";
import {
  type ConsolePaneAddress,
  type SidebarRowDragTarget,
  type SidebarSectionContext,
} from "../../../seats/index.js";
import { SessionStore, type ConsoleEntity } from "../../../store/index.js";
import { readSectionRollup, sectionRowDragBinding } from "./section-rollup-nodes.js";

const SESSION_ID = "session-rollup-nodes";
const RUNS_PANE: ConsolePaneAddress = { kind: "runs" };

type RollupContext = Omit<SidebarSectionContext, "isOpen" | "openPane">;

function run(id: string, state: string): ConsoleEntity {
  return { kind: "run", id, state, touchedAt: "2026-09-01T00:00:00.000Z" };
}

function contextOver(options: {
  readonly runs?: readonly ConsoleEntity[];
  readonly degraded?: boolean;
}): RollupContext {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  if (options.runs !== undefined) {
    sessionStore.initialise({ cursor: 0, entities: options.runs, participantJoinLog: [] });
  }
  if (options.degraded === true) {
    sessionStore.markDegraded("read-failed");
  }
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  return { sessionStore, bridge, filterQuery: "" };
}

/** The reading a section supplies, with `failed` the one state that is calling. */
function runsReading(): Parameters<typeof readSectionRollup>[1] {
  return {
    partition: "run",
    group: (entity) => (entity.state === "running" ? "running" : "rest"),
    attention: (entity) => (entity.state === "failed" ? "attention" : undefined),
    label: (entity) => `run ${entity.id}`,
    opens: RUNS_PANE,
  };
}

describe("a section's rollup nodes", () => {
  it("reports one flat node per item, carrying what the section named it", () => {
    const nodes = readSectionRollup(
      contextOver({ runs: [run("run-1", "running")] }),
      runsReading(),
    );

    expect(nodes).toStrictEqual([
      { nodeId: "run-1", label: "run run-1", group: "running", opens: RUNS_PANE },
    ]);
    // Flat, and the flatness is the claim: a projected run names no channel, so a
    // level here would be a parent the console made up.
    expect(nodes[0]).not.toHaveProperty("children");
  });

  it("omits the attention member on an item that is calling for nobody", () => {
    // Absent rather than present-and-undefined, because the fold reads presence and
    // the node shape says a node carrying nothing itself omits it.
    const nodes = readSectionRollup(
      contextOver({ runs: [run("run-1", "running")] }),
      runsReading(),
    );

    expect(nodes[0]).not.toHaveProperty("attention");
  });

  it("carries the item's own level where the section reported one", () => {
    const nodes = readSectionRollup(contextOver({ runs: [run("run-1", "failed")] }), runsReading());

    expect(nodes[0]?.attention).toBe("attention");
  });

  it("reports nothing at all from a store that has not answered", () => {
    expect(readSectionRollup(contextOver({}), runsReading())).toStrictEqual([]);
  });

  it("reports nothing at all from a store the daemon called incomplete", () => {
    // THE NEGATIVE CONTROL FOR THE GUARD, and the strongest case for it: the item that
    // would raise a mark IS in the store, and the section still reports nothing —
    // because the list it came from is a partial one, and counts drawn from a partial
    // list are the badge the sidebar refuses to synthesise.
    const context = contextOver({ runs: [run("run-1", "failed")], degraded: true });

    expect(readSectionRollup(context, runsReading())).toStrictEqual([]);
  });

  it("reads only the partition the section named", () => {
    const context = contextOver({
      runs: [
        run("run-1", "running"),
        { kind: "approval", id: "approval-1", state: "pending", touchedAt: "2026-09-01T00:00:00Z" },
      ],
    });

    expect(readSectionRollup(context, runsReading()).map((node) => node.nodeId)).toStrictEqual([
      "run-1",
    ]);
  });
});

describe("a section row's drag binding", () => {
  function recordingBinder(): {
    readonly bind: (target: SidebarRowDragTarget) => (element: HTMLElement | null) => void;
    readonly targets: readonly SidebarRowDragTarget[];
  } {
    const targets: SidebarRowDragTarget[] = [];
    return {
      bind: (target) => {
        targets.push(target);
        return () => {
          /* the gesture is the column's; this test owns only what it was handed */
        };
      },
      targets,
    };
  }

  it("keys a row by its section and its identifier, so two sections cannot collide", () => {
    const first = recordingBinder();
    sectionRowDragBinding(first.bind, {
      sectionId: "runs",
      entityId: "shared-id",
      label: "run shared-id",
      opens: RUNS_PANE,
    });
    const second = recordingBinder();
    sectionRowDragBinding(second.bind, {
      sectionId: "approvals",
      entityId: "shared-id",
      label: "approval shared-id",
      opens: { kind: "approvals" },
    });

    // The binder cache is the COLUMN's, one entry per id, so an identifier two
    // sections happen to share must not resolve to one bound element.
    expect(first.targets[0]?.nodeId).toBe("runs:shared-id");
    expect(second.targets[0]?.nodeId).toBe("approvals:shared-id");
    expect(first.targets[0]?.opens).toStrictEqual(RUNS_PANE);
  });

  it("binds nothing at all when the column handed down no binder", () => {
    // The negative control for the optional seam: no key, rather than a key holding
    // `undefined` — which under exact optional property types is a different row.
    const binding = sectionRowDragBinding(undefined, {
      sectionId: "runs",
      entityId: "run-1",
      label: "run run-1",
      opens: RUNS_PANE,
    });

    expect(binding).toStrictEqual({});
    expect(binding).not.toHaveProperty("bindDrag");
  });
});
