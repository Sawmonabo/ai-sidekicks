import type { ConsoleRefusal } from "../../core/index.js";
import { DerivedFigure, InlineRefusal, WireFigure } from "../../primitives/index.js";
import { type SidekickRegistryView } from "./definition-registry-view.js";
import { describeDeletionQuestion, type SidekickDefinitionRow } from "./definition-rows.js";

/** One saved sidekick: what it is, and the two things that can be done to it. */
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
}): React.JSX.Element {
  const { row, isArmed, isDeleting, isAnyDeleteInFlight, isOpenInEditor, refusal, view } = props;
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
