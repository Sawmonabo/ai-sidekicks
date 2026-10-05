import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { type AgentLibraryView } from "../library-view.js";
import { describeDeletionQuestion, type AgentDefinitionRow } from "../definition-rows.js";

/** One saved definition: what it is, and the three things that can be done to it. */
export function SavedDefinitionRow(props: {
  readonly row: AgentDefinitionRow;
  readonly isArmed: boolean;
  readonly isDeleting: boolean;
  /**
   * Whether any row's delete is running, this one's included. Delete has no undo and the
   * view admits one at a time, so every row's delete stops taking presses while one is in
   * flight; `isDeleting` still marks which record is going.
   */
  readonly isAnyDeleteInFlight: boolean;
  /** Whether the editor is currently open on this record. */
  readonly isOpenInEditor: boolean;
  readonly refusal: Refusal | undefined;
  readonly view: AgentLibraryView;
}): React.JSX.Element {
  const { row, isArmed, isDeleting, isAnyDeleteInFlight, isOpenInEditor, refusal, view } = props;
  return (
    <article
      className={
        isOpenInEditor
          ? "meridian-saved-definition-row meridian-saved-definition-row--open"
          : "meridian-saved-definition-row"
      }
    >
      <div className="meridian-saved-definition-row__head">
        <span className="meridian-saved-definition-row__name">{row.name}</span>
        <WireFigure value={row.definitionId} />
      </div>
      {row.description.length === 0 ? null : (
        <p className="meridian-saved-definition-row__description">{row.description}</p>
      )}
      <dl className="meridian-saved-definition-row__axes">
        {row.axes.map((axis) => (
          <div className="meridian-saved-definition-row__axis" key={axis.key}>
            <dt className="meridian-saved-definition-row__axis-label">{axis.label}</dt>
            <dd className="meridian-saved-definition-row__axis-reading">
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
        <div className="meridian-saved-definition-row__confirm" role="group">
          <p className="meridian-saved-definition-row__question">{describeDeletionQuestion(row)}</p>
          <button
            type="button"
            className={
              "meridian-saved-definition-row__action " +
              "meridian-saved-definition-row__action--destructive " +
              "meridian-action-button"
            }
            onClick={() => {
              void view.confirmDeletion(row.definitionId);
            }}
            disabled={isAnyDeleteInFlight}
          >
            Delete
          </button>
          <button
            type="button"
            className="meridian-saved-definition-row__action meridian-action-button"
            onClick={() => {
              view.cancelDeletion();
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="meridian-saved-definition-row__actions">
          <button
            type="button"
            className="meridian-saved-definition-row__action meridian-action-button"
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
            className={
              "meridian-saved-definition-row__action " +
              "meridian-saved-definition-row__action--destructive " +
              "meridian-action-button"
            }
            onClick={() => {
              view.armDeletion(row.definitionId);
            }}
            disabled={isAnyDeleteInFlight}
            aria-label={`Delete ${row.name}`}
          >
            {isDeleting ? "Deleting…" : "Delete"}
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
              className="meridian-saved-definition-row__action meridian-action-button"
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
