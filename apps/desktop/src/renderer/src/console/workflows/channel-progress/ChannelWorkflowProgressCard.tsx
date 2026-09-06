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
// Renders — the one live run this channel started: the definition's name, its state,
// its phases completed of phases known, and one park reading per parked phase, from
// `parks/ParkBadge.tsx` so the card and the run pane say the same thing about the same
// park. Nothing else: a pinned region is chrome, and a card that grew a phase list
// would be the run pane drawn in somebody else's head.
//
// Offers — nothing yet, and that absence is named rather than drawn. The blueprint's
// card links to the run view, and the route is a pane opener: the chrome that draws
// this region holds the deck's close and detach controls and no opener at all
// (`seats/pane-controls.ts`), and no console module publishes one through a context.
// A button that cannot open the pane it names is worse than the sentence saying where
// the run lives, so this card states the run's identity and offers no control. The
// route lands with the opener, in the diff that gives the region's host one.
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

import "./channel-progress.css";

import { useConsoleBridge } from "../../bridge/index.js";
import { Chip, WireFigure } from "../../primitives/index.js";
import { ParkBadge } from "../parks/ParkBadge.js";
import { useWorkflowRunDirectory } from "../runs/run-directory.js";
import { channelWorkflowProgress, type ChannelWorkflowProgress } from "./channel-progress.js";

export interface ChannelWorkflowProgressCardProps {
  /** The session whose runs are read. No session, no question to put. */
  readonly sessionId: string | undefined;
  /** The channel this pane is scoped to. Undefined on a session-scoped pane. */
  readonly channelId: string | undefined;
}

/**
 * The channel's live workflow run, pinned — or nothing at all.
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
  return progress === undefined ? null : <PinnedRunCard progress={progress} />;
}

/** The card itself, once there is a run to draw. */
function PinnedRunCard(props: { readonly progress: ChannelWorkflowProgress }): React.JSX.Element {
  const { row, completedPhaseCount, totalPhaseCount } = props.progress;
  return (
    <article className="meridian-channel-progress">
      <div className="meridian-channel-progress__head">
        {/*
          The definition's name where the enumeration carried one, and the run's own
          identifier always — rule 4's provenance signature on the wire figure, and the
          console's prose beside it. The name is optional on the row for the reason
          `runs/run-list-rows.ts` gives, so a card that showed only a name would show
          nothing for a run read that carried none.
        */}
        {row.run.definitionName === undefined ? null : (
          <span className="meridian-channel-progress__definition">{row.run.definitionName}</span>
        )}
        <WireFigure value={row.run.workflowRunId} />
        {/*
          The run's own state word, as the wire spells it. Neutral always: the amber in
          this card belongs to a park that is waiting on a person, and a second thing
          wearing attention beside it would spend the palette's one loud mark twice for
          one situation (`Spec-023 §Console Design (Meridian)` rule 3).
        */}
        <Chip tone="neutral" glyph="workflow" label={row.run.state} />
      </div>
      {/*
        Completed of known, and both numbers on screen. A bar or a percentage would
        hide the denominator, and this one moves: the phase list is what the run read
        carried when it answered, so a fan-out that adds phases changes what "of" means
        and a person can see that it did.
      */}
      <p className="meridian-channel-progress__phases">
        {`${String(completedPhaseCount)} of ${String(totalPhaseCount)} phases completed`}
      </p>
      {row.parkedPhases.map((parked) => (
        <ParkBadge key={parked.phaseId} parked={parked} />
      ))}
    </article>
  );
}
