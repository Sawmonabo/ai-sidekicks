// The reasoning row's body: the four arms, the streaming tail, and the one control.
//
// THE SHELL AND ITS DEATH NOTICE. The body a reasoning row eventually renders is the
// timeline plan's, absorbed by import — so this file is a slot with a shell behind
// it, and the change that authors the real body deletes the shell rather than
// leaving it beside one. `reasoning-surface.ts` carries the three facts that
// arrangement owes.
//
// WHAT THE SHELL DOES RENDER, and why it is a real surface rather than a placeholder.
// Three of the four availability arms carry no entries at all, which means the whole
// of what a reader sees for them is the sentence the state itself supplies. A shell
// that showed nothing for those three would be the exact defect the four-arm
// discriminant exists to prevent — `unavailable`, `compacted`, and `policy_redacted`
// rendering as one empty body — so the shell renders the arms.
//
// THE TAIL AND THE READ ARE TWO DIFFERENT THINGS AND ARE NOT RANKED AGAINST EACH
// OTHER. The tail is text the reveal engine is publishing right now, cut to the
// newest lines; the read is what the daemon says the durable surface holds. A turn
// that is still streaming has a tail and no read, a settled turn has a read and no
// tail, and a turn that streams while a reader expands it has both — so both render,
// in that order, rather than one hiding the other. Ranking them would mean a reader
// who expanded mid-turn lost sight of the arriving lines.
//
// THE CONTROL IS FAIL-CLOSED ABOUT ELIGIBILITY. The read is run-scoped; a row with
// no run attribution is a row the read could never answer for, so the control is
// ABSENT rather than present-and-disabled. A disabled control is a claim that the
// action exists and is not currently permitted, which is a different sentence from
// "this row is not addressable by that read at all" — and the second is the true one.

import { Nothing } from "../../../primitives/index.js";
import { WireFigure } from "../../../primitives/index.js";
import type { OwnerSlotProps } from "../../../seats/index.js";
import type { ReasoningEntry, ReasoningSurfaceReadResponse, RunId } from "@ai-sidekicks/contracts";
import {
  REASONING_ARM_COPY,
  reasoningTailOf,
  type ReasoningSurfaceReading,
} from "./reasoning-surface.js";

/** What the row hands the body the timeline plan authors. */
export interface ReasoningSurfaceBodyProps {
  readonly runId: RunId;
  readonly reading: ReasoningSurfaceReading;
}

export interface ReasoningSurfaceProps {
  /**
   * The plan-owned body's slot.
   *
   * Required and carrying `undefined` rather than optional, on `OwnerSlotProps`'
   * own terms: a mount that forgot the slot is a compile error at the construction
   * site rather than an absent key that renders identically to an unfilled one.
   */
  readonly slot: OwnerSlotProps<(props: ReasoningSurfaceBodyProps) => React.ReactNode>;
  /** The run this row's reasoning belongs to, or `undefined` where none is attributed. */
  readonly runId: RunId | undefined;
  /** Text the reveal engine is publishing for this row right now, while it streams. */
  readonly liveText: string | undefined;
  readonly reading: ReasoningSurfaceReading;
  /** Ask the daemon for this run's reasoning surface. */
  readonly onExpand: () => void;
}

export function ReasoningSurface(props: ReasoningSurfaceProps): React.JSX.Element {
  if (props.slot.body !== undefined && props.runId !== undefined) {
    return (
      <div className="meridian-reasoning-surface">
        {props.slot.body({ runId: props.runId, reading: props.reading })}
      </div>
    );
  }
  return (
    <div className="meridian-reasoning-surface">
      <ReasoningTail liveText={props.liveText} />
      <ReasoningReading reading={props.reading} />
      <ReasoningExpandControl
        runId={props.runId}
        reading={props.reading}
        onExpand={props.onExpand}
      />
    </div>
  );
}

/**
 * The newest lines of a turn that is still streaming, or nothing.
 *
 * `aria-live` is deliberately absent. The lines change many times a second while a
 * turn streams, and a live region here would read a reasoning trace aloud over
 * whatever a person was doing; the settlement is what gets announced, by the
 * surfaces that own announcements.
 */
function ReasoningTail(props: { readonly liveText: string | undefined }): React.JSX.Element | null {
  if (props.liveText === undefined) {
    return null;
  }
  const lines = reasoningTailOf(props.liveText);
  if (lines.length === 0) {
    return null;
  }
  return (
    <ol className="meridian-reasoning-surface__tail" aria-label="the newest reasoning lines">
      {lines.map((line, index) => (
        // The window slides, so a line's TEXT is not stable across frames and its
        // position in the window is. Keying on the text would remount every row each
        // time a line arrived; keying on the position remounts none of them, and the
        // list is a fixed-size window rather than a reorderable collection, which is
        // the case an index key is correct for.
        <li key={index} className="meridian-reasoning-surface__tail-line">
          {line}
        </li>
      ))}
    </ol>
  );
}

/** Whatever the read has said so far, in the shape that fact takes. */
function ReasoningReading(props: {
  readonly reading: ReasoningSurfaceReading;
}): React.JSX.Element | null {
  switch (props.reading.status) {
    case "not-asked":
      return null;
    case "reading":
      return (
        <Nothing kind="not-loaded" placement="surface" title="Reading this turn's reasoning." />
      );
    case "refused":
      return (
        <Nothing
          kind="error"
          placement="surface"
          title={props.reading.refusal.code}
          detail={props.reading.refusal.detail}
        />
      );
    case "read":
      return <ReasoningArm response={props.reading.response} />;
  }
}

/** One arm of the closed availability discriminant, rendered as itself. */
function ReasoningArm(props: {
  readonly response: ReasoningSurfaceReadResponse;
}): React.JSX.Element {
  const response = props.response;
  if (response.availability === "available" && response.reasoningEntries.length > 0) {
    return (
      <>
        <ReasoningEntries entries={response.reasoningEntries} />
        {response.hasMore ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="More reasoning follows this page."
            detail="This page is bounded and the continuation has not been asked for."
          />
        ) : null}
      </>
    );
  }
  const copy = REASONING_ARM_COPY[response.availability];
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title={copy.title}
      detail={copy.detail}
      {...(response.availability === "policy_redacted"
        ? // VERBATIM, in the wire's own figure. The reason is the daemon's sentence
          // about its own policy and the console neither paraphrases nor summarizes
          // it — rendering it as prose of the console's own would make a redaction
          // read as the console's opinion of one.
          { action: <WireFigure value={response.policyReason} title="Policy reason" /> }
        : {})}
    />
  );
}

/** The entries themselves, ordered by the sequence the daemon put them in. */
function ReasoningEntries(props: {
  readonly entries: readonly ReasoningEntry[];
}): React.JSX.Element {
  return (
    <ol className="meridian-reasoning-surface__entries" aria-label="reasoning entries">
      {props.entries.map((entry) => (
        <li key={entry.sequence} className="meridian-reasoning-surface__entry">
          {entry.content}
        </li>
      ))}
    </ol>
  );
}

/**
 * The one offer this surface makes.
 *
 * Absent where the read cannot address the row, and absent once the read has
 * answered: a second press would re-ask a question that has an answer on screen, and
 * this surface holds no continuation cursor to spend on the bounded page's tail.
 */
function ReasoningExpandControl(props: {
  readonly runId: RunId | undefined;
  readonly reading: ReasoningSurfaceReading;
  readonly onExpand: () => void;
}): React.JSX.Element | null {
  if (props.runId === undefined || props.reading.status !== "not-asked") {
    return null;
  }
  return (
    <button type="button" className="meridian-reasoning-surface__expand" onClick={props.onExpand}>
      Show reasoning
    </button>
  );
}
