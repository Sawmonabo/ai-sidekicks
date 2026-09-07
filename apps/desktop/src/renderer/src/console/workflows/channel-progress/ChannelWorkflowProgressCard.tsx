// The card a channel pins above its timeline: which workflow this room started, how
// far it has got, and whether it is waiting on somebody.
//
// `Spec-023 §Console Design (Meridian)` gives a pane one entity and one body; a channel
// whose conversation started a workflow has a second thing to say that is not a row in
// the ledger and not the ledger's subject. So it rides the pane chrome's pinned region
// (`seats/pinned-pane-regions.ts`) — above the body, outside the body's scroller, and
// registered by THIS family rather than by the family that owns the pane, because the
// progress is this family's fold and a sibling import is what the layering rules refuse.
//
// Renders — the run this channel most needs looked at: the definition's name, its
// state, its phases completed of phases known, and one park reading per parked phase,
// from `parks/ParkBadge.tsx` so the card and the run pane say the same thing about the
// same park. Nothing else: a pinned region is chrome, and a card that grew a phase list
// would be the run pane drawn in somebody else's head.
//
// ONE RUN, AND NOT BECAUSE THERE IS ONLY ONE. `Spec-017 §Chat-start surface (SA-38)`
// registers `channelId` as PROVENANCE, so nothing stops a room starting a second run
// while the first is still going — the pick is `channel-progress.ts`', it is the run
// list's own parked-first-then-newest-first reading, and it is tested. What the card
// draws is the head of that order, not the only member of it.
//
// Offers — the route to the run's own pane, and only where the host handed one down.
// The route is a pane opener, which is the deck's act rather than this card's: it
// arrives on the pinned region's context (`seats/pinned-pane-regions.ts`), forwarded
// by the chrome off the `PaneControls` the deck provides. A host with no deck — the
// auxiliary window, a full-width surface — hands over nothing, and the card then
// states the run's identity and draws no control, because a button that cannot open
// the pane it names is worse than the sentence saying where the run lives.
//
// Never — never polls, and holds no timer: it reads through the run directory's one
// read-per-mount, which is the read the runs surface already performs, so a channel
// that opens a timeline asks once and a channel that never opens one asks nothing.
// Never reads a park from a phase's `state`, which carries no suspended arm on purpose.
// Never renders for a channel no run named, and never renders a settled run — both are
// the region contributing no element, which is what a pinned region's absence IS.
// Never pins a refusal: the run enumeration is unregistered wire
// (`Plan-023 §Console growth slate`), so on a live bridge this read refuses for every
// channel in every session, and a refusal drawn here would be a permanent banner above
// every conversation reporting a feature the room may never use. The refusal reaches
// the diagnostic band through the port that raised it and reaches this card as nothing.
//
// States — absent (no channel in scope, no run scoped to it, or every scoped run
// settled): no element. Unasked and in flight: no element, for the same reason — a
// region that appeared and then changed size under the first line of a conversation is
// the one piece of chrome a reader cannot get out of the way. Served with a live run:
// the card. Parked: the card, with one park reading per parked phase.

import { useMemo } from "react";

import { useConsoleBridge } from "../../bridge/index.js";
import type { ConsolePaneOpener } from "../../seats/index.js";
import { useWorkflowRunDirectory } from "../runs/run-directory.js";
import { channelWorkflowProgress } from "./channel-progress.js";
import { PinnedRunCard } from "./PinnedRunCard.js";

export interface ChannelWorkflowProgressCardProps {
  /** The session whose runs are read. No session, no question to put. */
  readonly sessionId: string | undefined;
  /** The channel this pane is scoped to. Undefined on a session-scoped pane. */
  readonly channelId: string | undefined;
  /**
   * The deck's pane opener, where the pane's host offers one.
   *
   * Absent is a state and not a default: a pane drawn outside a deck has nowhere to
   * put a second pane, so the card draws no route rather than a control that could
   * not act.
   */
  readonly openPane?: ConsolePaneOpener | undefined;
}

/**
 * The run this channel most needs looked at, pinned — or nothing at all.
 *
 * The read is the runs surface's own hook rather than a second one: one subject, one
 * read per mount, one settlement vocabulary. What this adds is the channel narrowing,
 * which happens on the ANSWER rather than in the request, because the enumeration is
 * keyed by session and a per-channel request member would be a narrowing no wire
 * carries.
 */
export function ChannelWorkflowProgressCard(
  props: ChannelWorkflowProgressCardProps,
): React.JSX.Element | null {
  const bridge = useConsoleBridge();
  const directory = useWorkflowRunDirectory(bridge.growth, props.sessionId);
  const progress =
    directory.status === "served"
      ? channelWorkflowProgress(directory.runs, props.channelId)
      : undefined;
  const { openPane } = props;
  const workflowRunId = progress?.row.run.workflowRunId;
  // The eligibility is the VALUE rather than a branch in the drawing below it: with no
  // opener and with no run there is no act, and a card handed `undefined` draws no
  // control at all. The address is the one `workflows/destination/` already opens a run
  // with, so a run reached from a channel and a run reached from the runs list land in
  // the same pane rather than in two that agree by hand.
  const openRun = useMemo(
    () =>
      openPane === undefined || workflowRunId === undefined
        ? undefined
        : (): void => {
            openPane({
              kind: "workflow-run",
              entity: { kind: "workflow-run", id: workflowRunId },
            });
          },
    [openPane, workflowRunId],
  );
  return progress === undefined ? null : <PinnedRunCard progress={progress} onOpenRun={openRun} />;
}
