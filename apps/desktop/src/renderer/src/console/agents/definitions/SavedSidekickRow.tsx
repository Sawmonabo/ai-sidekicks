// One saved sidekick, and the three things that can be done to it.
//
// ATTACH FROM HERE IS AN OFFER AND NOT A NAVIGATION. Pressing it hands this
// definition to the session this window is working in, through the window's own
// attach handoff; the session's attach form claims it and opens on it. Nothing
// navigates, because this row does not know whether that session's agent console is
// open and a control that moved somebody to a surface it had not opened would be
// claiming an act it did not perform. What the row does instead is SAY where the
// offer is waiting, and offer to take it back.
//
// THE CONTROL IS ABSENT WITHOUT A SESSION, never disabled. An agent joins a session,
// so with none open there is nothing to attach into and no act to offer — and a
// disabled control would assert that the act exists and is momentarily unavailable,
// which is exactly the claim the console's rules refuse. The column above says once
// why it is missing, rather than every row saying it.
//
// THE OFFER CARRIES THE ID AND THE NAME TRAVELS FOR DISPLAY ONLY. `definitionId` is
// what the attach form resolves against its own read; the name is the word this row
// showed at the moment of the press, so the sentence reads as one.
//
// AND IT CARRIES THE SESSION, WHICH IS HALF OF WHETHER IT IS THIS ROW'S OFFER. The
// handoff holds one offer per window and honours it only for the session it names —
// `AttachHandoff.claim` refuses a mismatched session outright — so a row that matched
// on the definition alone would disagree with the rule that decides the outcome. That
// is reachable without doing anything strange: offer a definition for one session,
// move the window to another, and reopen this page before the first session's attach
// form has claimed it. What the row asks is therefore the claim's own question — is
// this the offer the session this window is working in would take — and the note
// names the OFFER's session rather than the window's, so the sentence stays true from
// whichever session the page is read.
//
// AN OFFER STANDING FOR ANOTHER SESSION LEAVES BOTH ACTS ON THE ROW. The offer is
// real and withdrawable from here, so the note and its way back stay; and this
// window's own session can still be offered to, because the handoff holds ONE offer
// and a press replaces the standing one. That supersession is stated rather than
// performed silently — in the note for a person reading the card, and in the action's
// accessible name because DOM order puts the note after the control, so somebody
// arriving by keyboard meets it before the press instead of after it.

import type { ConsoleRefusal } from "../../core/index.js";
import { DerivedFigure, InlineRefusal, WireFigure } from "../../primitives/index.js";
import type { AttachHandoffControl } from "../attach/attach-handoff/index.js";
import { type SidekickRegistryView } from "./definition-registry-view.js";
import { describeDeletionQuestion, type SidekickDefinitionRow } from "./definition-rows.js";

/** One saved sidekick: what it is, and the three things that can be done to it. */
export function SavedSidekickRow(props: {
  readonly row: SidekickDefinitionRow;
  readonly isArmed: boolean;
  readonly isDeleting: boolean;
  /**
   * Whether ANY row's delete is running, this one's included.
   *
   * Delete is the one act here with no undo and the carrier admits one at a time, so
   * every row's delete control stops taking presses while one is in flight — the
   * refusal the carrier raises for a press that gets through anyway is the belt, not
   * the ordinary path. The pending row keeps its own treatment through `isDeleting`
   * above, so a person can still see which record is going.
   */
  readonly isAnyDeleteInFlight: boolean;
  /** Whether the detail column's one seat is currently holding this record. */
  readonly isOpenInEditor: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly view: SidekickRegistryView;
  /** This window's one attach handoff: what a press offers into, and reads back. */
  readonly handoff: AttachHandoffControl;
  /** The session an offer is made for, or `undefined` where this window holds none. */
  readonly attachTargetSessionId: string | undefined;
}): React.JSX.Element {
  const { row, isArmed, isDeleting, isAnyDeleteInFlight, isOpenInEditor, refusal, view } = props;
  const { handoff, attachTargetSessionId } = props;
  const { standingOffer } = handoff;
  // The window's one offer, where it names THIS definition — whichever session it was
  // made for. It is what the note and the way back are about.
  const offerForThisDefinition =
    standingOffer?.definitionId === row.definitionId ? standingOffer : undefined;
  // ...and whether that offer is the one this window's session would claim. Written as
  // a conjunction rather than as a comparison of two possibly-undefined values,
  // because `undefined === undefined` would call a row with no offer at all offered.
  const isOfferedToTargetSession =
    offerForThisDefinition !== undefined &&
    offerForThisDefinition.sessionId === attachTargetSessionId;
  // The move a press from here would make, where it would make one: an offer for this
  // definition standing in another session, and this window's own session it would go
  // to. THE PAIR RATHER THAN EITHER HALF, because the sentence and the accessible name
  // each need one of them and a row missing a session has neither — so one binding
  // decides whether the supersession is real and both readers narrow off it.
  const offerSupersession =
    offerForThisDefinition === undefined ||
    isOfferedToTargetSession ||
    attachTargetSessionId === undefined
      ? undefined
      : {
          standingInSessionId: offerForThisDefinition.sessionId,
          movingToSessionId: attachTargetSessionId,
        };
  return (
    <article
      className={
        isOpenInEditor
          ? "meridian-sidekick-row meridian-sidekick-row--open"
          : "meridian-sidekick-row"
      }
    >
      <div className="meridian-sidekick-row__head">
        <span className="meridian-sidekick-row__name">{row.name}</span>
        <WireFigure value={row.definitionId} />
      </div>
      {row.description.length === 0 ? null : (
        <p className="meridian-sidekick-row__description">{row.description}</p>
      )}
      <dl className="meridian-sidekick-row__axes">
        {row.axes.map((axis) => (
          <div className="meridian-sidekick-row__axis" key={axis.key}>
            <dt className="meridian-sidekick-row__axis-label">{axis.label}</dt>
            <dd className="meridian-sidekick-row__axis-reading">
              {axis.source === "wire" ? (
                <WireFigure value={axis.reading} />
              ) : (
                <DerivedFigure text={axis.reading} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {isArmed ? (
        <div className="meridian-sidekick-row__confirm" role="group">
          <p className="meridian-sidekick-row__question">{describeDeletionQuestion(row)}</p>
          <button
            type="button"
            className="meridian-sidekick-row__action meridian-sidekick-row__action--destructive"
            onClick={() => {
              void view.confirmDeletion(row.definitionId);
            }}
            disabled={isAnyDeleteInFlight}
          >
            Delete
          </button>
          <button
            type="button"
            className="meridian-sidekick-row__action"
            onClick={() => {
              view.cancelDeletion();
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="meridian-sidekick-row__actions">
          <button
            type="button"
            className="meridian-sidekick-row__action"
            onClick={() => {
              view.openEditor({ kind: "stored", definitionId: row.definitionId });
            }}
            aria-label={`Edit ${row.name}`}
            aria-pressed={isOpenInEditor}
          >
            Edit
          </button>
          <button
            type="button"
            className="meridian-sidekick-row__action meridian-sidekick-row__action--destructive"
            onClick={() => {
              view.armDeletion(row.definitionId);
            }}
            disabled={isAnyDeleteInFlight}
            aria-label={`Delete ${row.name}`}
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
          {attachTargetSessionId === undefined || isOfferedToTargetSession ? null : (
            <button
              type="button"
              className="meridian-sidekick-row__action"
              onClick={() => {
                handoff.offer({
                  sessionId: attachTargetSessionId,
                  definitionId: row.definitionId,
                  definitionName: row.name,
                });
              }}
              aria-label={
                offerSupersession === undefined
                  ? `Attach ${row.name} from here`
                  : `Attach ${row.name} from here, moving the offer waiting in ${offerSupersession.standingInSessionId}`
              }
            >
              Attach from here
            </button>
          )}
        </div>
      )}
      {offerForThisDefinition === undefined ? null : (
        <div className="meridian-sidekick-row__handoff" role="group">
          <p className="meridian-sidekick-row__handoff-note">
            Waiting in <WireFigure value={offerForThisDefinition.sessionId} />. That session&rsquo;s
            attach form opens on this sidekick.
            {offerSupersession === undefined ? null : (
              <>
                {" "}
                Attaching from here moves it to{" "}
                <WireFigure value={offerSupersession.movingToSessionId} /> instead — this window
                holds one offer at a time.
              </>
            )}
          </p>
          <button
            type="button"
            className="meridian-sidekick-row__action"
            onClick={() => {
              handoff.withdraw();
            }}
            aria-label={`Stop attaching ${row.name}`}
          >
            Not now
          </button>
        </div>
      )}
      {refusal === undefined ? null : (
        <InlineRefusal
          code={refusal.code}
          detail={refusal.detail}
          action={
            <button
              type="button"
              className="meridian-sidekick-row__action"
              onClick={() => {
                view.dismissRefusal(row.definitionId);
              }}
            >
              Dismiss
            </button>
          }
        />
      )}
    </article>
  );
}
