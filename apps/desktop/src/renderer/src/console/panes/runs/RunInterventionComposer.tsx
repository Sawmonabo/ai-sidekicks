// Composing the two controls that carry a body: steer, and the rewind composite.
//
// `Spec-023 §Console Design (Meridian)` §7.3 opens with the rule this component
// exists for: **preview is consent.** "The scope of the rewind, which turns and
// which run position, is shown before the confirm, on every rewind without
// exception." So a rewind is never a button that fires — it is a target position, a
// preview of what that position means for this run, and then a confirm.
//
// WHAT THE PREVIEW CAN HONESTLY SHOW. The scope's turn-by-turn half belongs to the
// timeline, which this pane does not hold; what this pane holds is the run's own
// figures — the position asked for, the run version the guard will carry, and the
// state the run is in. Those are shown, and the sentence beside them says what a
// confirmed rewind does: the run lands `paused` at the confirmed position and
// nothing resumes on its own.
//
// THREE REFUSALS THIS SURFACE RAISES BEFORE THE WIRE.
//
//   • A rewind with no target position. The cut is daemon-supplied and this pane
//     computes none — §7.3's Never list forbids deriving one — so an unnamed
//     position is a refusal here rather than a request the daemon has to reject.
//   • A rewind whose target is not a position. The field's whole trimmed value is
//     read through `rewind-position.ts`, so a typed suffix is refused rather than
//     truncated into the position it happens to start with — a prefix parse turns
//     `4oops` into a destructive rollback to 4 that the daemon cannot tell from one
//     somebody meant.
//   • A composite whose replacement is empty. "Never offers an unchanged resend as
//     a rewind: a no-op composite is refused at the affordance rather than
//     destroying a tail for nothing." Empty text is the reachable form of that at a
//     surface with no original body to compare against.
//
// The four STRUCTURAL guards — no active turn, no pending send, a participant-
// authored boundary, a resumable target — are the daemon's, each fail-closed at
// admission, and each arrives here as a typed rejection carrying its own reason.
// This file refuses none of them and would be wrong to try.

import { useCallback, useId, useState } from "react";

import { InlineRefusal } from "../../primitives/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { parseRewindPosition } from "./rewind-position.js";
import { RUN_CONTROL_REFUSAL_ORIGIN } from "./run-control-dispatch.js";
import type { RunControlSurface } from "./run-control-surface.js";
import type { RunProjection } from "./run-state-feed.js";

/** Which of the two body-carrying controls is being composed. */
export type ComposedControl = "steer" | "rollback";

export interface RunInterventionComposerProps {
  readonly run: RunProjection;
  readonly control: ComposedControl;
  readonly surface: RunControlSurface;
  /** Close the composer without dispatching. */
  readonly onDismiss: () => void;
}

export function RunInterventionComposer(props: RunInterventionComposerProps): React.JSX.Element {
  const { run, control, surface } = props;
  const [body, setBody] = useState("");
  const [targetPosition, setTargetPosition] = useState("");
  const [localRefusal, setLocalRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const bodyId = useId();
  const positionId = useId();
  const comparand = surface.dispatcher.freshComparandFor(run.runId) ?? run.runVersion;

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (control === "steer") {
        if (body.trim().length === 0) {
          setLocalRefusal(
            refuse(
              RUN_CONTROL_REFUSAL_ORIGIN,
              "empty-directive",
              "There is nothing to steer with yet. Type what the run should do differently.",
            ),
          );
          return;
        }
        setLocalRefusal(undefined);
        surface.dispatch(run.runId, "steer", (dispatcher) =>
          dispatcher.steer({ runId: run.runId, expectedRunVersion: comparand }, { content: body }),
        );
        props.onDismiss();
        return;
      }
      const reading = parseRewindPosition(targetPosition);
      if (reading.status !== "named") {
        setLocalRefusal(
          reading.status === "unnamed"
            ? refuse(
                RUN_CONTROL_REFUSAL_ORIGIN,
                "target-position-unnamed",
                "A rewind needs the turn-boundary position it should land at. The console does not compute one — the position comes from the run's own recorded boundaries.",
              )
            : refuse(
                RUN_CONTROL_REFUSAL_ORIGIN,
                "target-position-unreadable",
                "A turn-boundary position is a whole number, and this field holds something else. Nothing was sent: the run's own recorded boundaries are where the position comes from.",
              ),
        );
        return;
      }
      const replacement = body.trim();
      if (body.length > 0 && replacement.length === 0) {
        setLocalRefusal(
          refuse(
            RUN_CONTROL_REFUSAL_ORIGIN,
            "empty-replacement",
            "A replacement message has to say something. Clear the field to rewind without one, or type the message that should take its place.",
          ),
        );
        return;
      }
      setLocalRefusal(undefined);
      surface.dispatch(run.runId, "rollback", (dispatcher) =>
        dispatcher.rollback(
          { runId: run.runId, expectedRunVersion: comparand },
          replacement.length === 0
            ? { targetPosition: reading.position }
            : { targetPosition: reading.position, replacementSend: { content: replacement } },
        ),
      );
      props.onDismiss();
    },
    [control, body, targetPosition, surface, run.runId, comparand, props],
  );

  return (
    <form className="meridian-run-composer" onSubmit={onSubmit}>
      <h4 className="meridian-run-composer__title">
        {control === "steer" ? "Steer this run" : "Rewind this run"}
      </h4>
      {control === "rollback" ? (
        <>
          <label className="meridian-run-composer__label" htmlFor={positionId}>
            Turn-boundary position to land at
          </label>
          <input
            id={positionId}
            className="meridian-run-composer__position"
            type="text"
            inputMode="numeric"
            value={targetPosition}
            onChange={(event) => {
              setTargetPosition(event.target.value);
            }}
          />
          <p className="meridian-run-composer__preview">
            A confirmed rewind leaves run {run.runId} paused at the confirmed position, guarded
            against run version {String(comparand)}. Nothing resumes on its own, no delivered row is
            removed, and rewound turns stay in the timeline marked as superseded.
          </p>
        </>
      ) : null}
      <label className="meridian-run-composer__label" htmlFor={bodyId}>
        {control === "steer" ? "What should it do differently" : "Replacement message (optional)"}
      </label>
      <textarea
        id={bodyId}
        className="meridian-run-composer__body"
        value={body}
        rows={3}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      {control === "rollback" && body.trim().length > 0 ? (
        <p className="meridian-run-composer__composite">
          This sends the rewind and the replacement as one intervention. The replacement is queued
          against the run and sends on the next resume; it is not dispatched by the rewind.
        </p>
      ) : null}
      {localRefusal === undefined ? null : (
        <InlineRefusal code={localRefusal.code} detail={localRefusal.detail} />
      )}
      <div className="meridian-run-composer__actions">
        <button type="submit" className="meridian-run-composer__confirm">
          {control === "steer" ? "Send steer" : "Confirm rewind"}
        </button>
        <button type="button" className="meridian-run-composer__dismiss" onClick={props.onDismiss}>
          Cancel
        </button>
      </div>
    </form>
  );
}
