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
// which is the claim `Spec-023 §Console Design (Meridian)`'s eight rules refuse. The
// column above says once why it is missing, rather than every row saying it.
//
// THE OFFER CARRIES THE ID AND THE NAME TRAVELS FOR DISPLAY ONLY. `definitionId` is
// what the attach form resolves against its own read; the name is the word this row
// showed at the moment of the press, so the sentence reads as one.

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
  const isOfferedForAttach = handoff.standingOffer?.definitionId === row.definitionId;
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
          {attachTargetSessionId === undefined || isOfferedForAttach ? null : (
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
              aria-label={`Attach ${row.name} from here`}
            >
              Attach from here
            </button>
          )}
        </div>
      )}
      {isOfferedForAttach ? (
        <div className="meridian-sidekick-row__handoff" role="group">
          <p className="meridian-sidekick-row__handoff-note">
            Waiting in <WireFigure value={attachTargetSessionId ?? ""} />. That session&rsquo;s
            attach form opens on this sidekick.
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
      ) : null}
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
