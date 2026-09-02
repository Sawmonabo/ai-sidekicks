// The timeline row slot — the one seat Plan-013 absorbs by import.
//
// THE ABSORB-BY-IMPORT RULE, WHICH IS WHAT THIS SEAT IS FOR
//
// Every other seat in this family is filled by a console view family and stays
// filled. This one is filled TWICE, in two PRs, and the second deletes the first:
//
//   1. The workspace family (T-023p-1C-2) registers a FIXTURE SHELL here — a row
//      that renders the ledger primitive against the fixture scenarios so the
//      timeline surface is real before Plan-013's rows exist.
//   2. The `timeline/` subtree, which Plan-013 owns, replaces that registration in
//      its own PR — and DELETES the shell in the same diff. Two registrations
//      would not merely be untidy: the seat is owner-scoped, so the second owner
//      is refused and the timeline stops rendering at import time.
//
// `apps/desktop/AGENTS.md` states the boundary this rests on: "The console imports
// no plan-owned renderer subtree whose owner mounts into it — `timeline/`, … Those
// reach the frame by calling `registerConsoleSurface`, which is a call and not an
// import". The same holds here: the console never imports `timeline/`, and
// `timeline/` reaches the row by calling `registerTimelineRowRenderer`.
//
// WHY THE PROPS ARE NOT JUST `row`
//
// Three of the four members are decisions the LIST makes, not facts the row
// carries, and a renderer that re-derived them would be a second source of truth
// for each:
//
//   • `participantHue` is allocated by `ParticipantHueAllocator` over the session's
//     join log — order-dependent state no single row can see.
//   • `isSuperseded` is a rollback-boundary ranking over the rows AROUND this one.
//     Only `TimelineRow`'s `run` arm carries a `superseded` marker at all; a
//     `general` or `legacy_stub` row after a boundary is superseded too and says
//     so nowhere in its own shape.
//   • `density` is the list's collapse state for this row, under `Spec-023
//     §Console Design (Meridian)` rule 7's density budgets.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { type ParticipantHueAssignment } from "../tokens/index.js";
import { SingleSlotSeat } from "./single-slot-seat.js";

// Consumed by T-023p-1C-2
/**
 * A row's collapse state, under `Spec-023 §Console Design (Meridian)` rule 7:
 * "Tool rows render as one line until opened; run chapters collapse once terminal
 * and the live chapter stays open".
 *
 * Two values and not a numeric scale: the rule is about what is COLLAPSED, and a
 * comfortable/compact spacing axis would be a second, unrelated meaning wearing
 * the same word.
 */
export const TIMELINE_ROW_DENSITIES = ["collapsed", "expanded"] as const;

// Consumed by T-023p-1C-2
/** One row's collapse state. Derived from the enumeration, never restated. */
export type TimelineRowDensity = (typeof TIMELINE_ROW_DENSITIES)[number];

// Consumed by T-023p-1C-2
/** What the timeline list hands each row. */
export interface TimelineRowSlotProps {
  /** The projected row, wire-verbatim, as `@ai-sidekicks/contracts` defines it. */
  readonly row: TimelineRow;
  /**
   * The author's place on the twelve-step wheel, or `undefined` for a row with no
   * attributable participant.
   *
   * The whole assignment rather than a colour string because
   * `Spec-023 §Console Design (Meridian)` rule 2 is explicit that "the hue is
   * never the sole attribution channel" — past twelve participants the wheel wraps
   * and the ring treatment is what tells two people on one step apart. A row handed
   * only a colour could not render that, and `undefined` is the fail-closed answer
   * rather than step zero, which belongs to somebody.
   */
  readonly participantHue: ParticipantHueAssignment | undefined;
  /** Whether a rollback boundary later in the list supersedes this row. */
  readonly isSuperseded: boolean;
  readonly density: TimelineRowDensity;
}

// Consumed by T-023p-1C-2
/** The row body. Returns `React.ReactNode` so the list can render it directly. */
export type TimelineRowRenderer = (props: TimelineRowSlotProps) => React.ReactNode;

const timelineRowSeat = new SingleSlotSeat<TimelineRowRenderer>(
  "timeline row",
  "the fixture shell is REPLACED by the timeline subtree, not registered beside it — delete the shell in the PR that registers the real row",
);

// Consumed by T-023p-1C-2
/**
 * The call a row owner makes to fill the seat.
 *
 * Both owners call this: the fixture shell first, then the `timeline/` subtree in
 * the PR that deletes the shell. The owner-scoped policy is what makes forgetting
 * the deletion loud — a second owner is refused by name rather than winning or
 * losing by import order.
 */
export function registerTimelineRowRenderer(owner: string, render: TimelineRowRenderer): void {
  timelineRowSeat.register({ owner, render });
}

// Consumed by T-023p-1C-2
/**
 * Release the seat.
 *
 * Test scaffolding: the seat is module-scope, so a case that fills it would leak
 * into the next one. The shell is retired by DELETING its registration, never by
 * calling this.
 */
export function unregisterTimelineRowRenderer(): void {
  timelineRowSeat.unregister();
}

// Consumed by T-023p-1C-2
/** The row body, or `undefined` while the seat is empty. */
export function timelineRowRenderer(): TimelineRowRenderer | undefined {
  return timelineRowSeat.renderer();
}
