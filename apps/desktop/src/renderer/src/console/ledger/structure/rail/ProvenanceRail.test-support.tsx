// The mounted rail both ProvenanceRail suites drive.
//
// Two files mount the same component — one about what it renders and how a keyboard
// walks it, one about the preview grace on a frozen clock — and both need the same
// four-mark session, the same harness over a mounted rail, and the same empty rail.
// Written twice they would drift, and the second suite's claims would quietly stop
// being about the same rail as the first's.
//
// happy-dom reports zeroes for every rect and answers `null` from `getContext`. That
// is deliberate rather than worked around: the rail's own guards make a zero-height
// strip and an absent 2D context no-ops, so what this harness exposes is the layer
// that survives them.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { render, screen } from "@testing-library/react";
import { type ReactElement } from "react";

import { ManualClock } from "../../../core/index.js";
import { ProvenanceRail } from "./ProvenanceRail.js";
import { ProvenanceRailModel } from "./rail-model.js";
import { generalRow, runRow } from "../timeline-rows.test-support.js";

/** Four marks: a message, an approval, a tool error, and a handoff. */
export function storyRows(): readonly TimelineRow[] {
  return [
    generalRow({
      id: "m1",
      sequence: 1,
      type: "user.message",
      category: "interactive_request",
      summary: "asked for the deploy plan",
    }),
    runRow({
      id: "ap",
      sequence: 2,
      type: "approval.requested",
      category: "approval_flow",
      runId: "run-a",
      position: 1,
      summary: "wants to write outside the worktree",
    }),
    runRow({
      id: "te",
      sequence: 3,
      type: "tool.error",
      category: "tool_activity",
      runId: "run-a",
      position: 2,
      summary: "the build step exited 1",
    }),
    runRow({
      id: "ha",
      sequence: 4,
      type: "agent.attached",
      category: "membership_change",
      runId: "run-a",
      position: 3,
      summary: "a second agent joined",
    }),
  ];
}

export function railModel(hasEarlierRows = false): ProvenanceRailModel {
  return new ProvenanceRailModel({ hasEarlierRows, rows: storyRows() });
}

/** A rail over a session that has produced nothing yet. Built per case: the
 * model memoizes on first read, and two cases sharing one memo would share a
 * cache rather than a fixture. */
export function emptyRail(): ProvenanceRailModel {
  return new ProvenanceRailModel({ rows: [], hasEarlierRows: false });
}

/** What a mounted rail lets a case observe. */
export interface RailHarness {
  readonly slider: HTMLElement;
  /** Row ids the rail asked the ledger to scroll to, in press order. */
  readonly jumps: readonly string[];
  /** How many times it asked for earlier rows. */
  loadEarlierCount(): number;
  /** Hand the SAME mounted rail a different model — a replay, a filter, a prune. */
  showModel(model: ProvenanceRailModel): void;
}

export function renderRail(
  options: {
    readonly model?: ProvenanceRailModel;
    readonly clock?: ManualClock;
    /** Whether a caller can page earlier rows at all. Absent, no affordance is drawn. */
    readonly canLoadEarlier?: boolean;
    /** The viewport band the thumb draws. The head quarter of the rail by default. */
    readonly viewport?: { readonly position: number; readonly extent: number };
  } = {},
): RailHarness {
  const jumps: string[] = [];
  let loadEarlierCount = 0;
  const loadEarlier = (): void => {
    loadEarlierCount += 1;
  };
  const clock = options.clock ?? new ManualClock();
  const railOver = (model: ProvenanceRailModel): ReactElement => (
    <ProvenanceRail
      model={model}
      viewportPosition={options.viewport?.position ?? 0}
      viewportExtent={options.viewport?.extent ?? 0.25}
      isFollowing={false}
      onJumpToRow={(rowId) => jumps.push(rowId)}
      {...(options.canLoadEarlier === false ? {} : { onLoadEarlier: loadEarlier })}
      clock={clock}
    />
  );
  const view = render(railOver(options.model ?? railModel()));
  return {
    slider: screen.getByRole("slider"),
    jumps,
    loadEarlierCount: () => loadEarlierCount,
    showModel: (model) => {
      view.rerender(railOver(model));
    },
  };
}
