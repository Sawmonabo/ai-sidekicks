// The sidekicks page: the sidekicks a person has tuned, so a configuration
// outlives the session it was typed into.
//
// WHAT IS ON THIS PAGE TODAY: THE REGISTRY, READ
//
// `sidekickDefinitionList` is registered on the growth port beside its create,
// update, and delete verbs, so the page puts one read in flight on mount and
// renders whichever of four answers comes back — a read still going, the port's own
// refusal with its code, a served empty registry, or the rows. Those four stay
// apart because they are different facts: "nobody has answered yet", "the answer
// was no", and "there are none" are three separate things, and a page that showed
// an empty list for either of the first two would assert something nothing on this
// machine established.
//
// ONE READ, AND A RE-READ ONLY WHERE SOMETHING MOVED. The list is read on mount and
// again after a delete the daemon applied, which is the one moment this page knows
// the registry changed. Nothing polls, and `store/scheduling.ts` is where a refresh
// cadence would land if one were ever wanted. The `not-loaded` absence is entered
// once and never re-entered: a re-read that blanked the list would take rows off the
// screen to show a spinner for data the page is already holding.
//
// DELETE IS TWO STEPS, IN THE ROW. Press Delete and the row asks; press again and
// the call goes out. There is no browser dialog in this console and no dialog of our
// own either — the subject of the question is the row, so the question belongs on
// the row, where a person can still read what they are about to delete. The pending
// state, the daemon's refusal, and the re-read on success all land there too.
//
// EDIT AND NEW OPEN THE SAME SEAT. `DefinitionEditorSlot.tsx` declares a subject
// with exactly two arms — a stored record, or one being composed — and this page
// supplies whichever was asked for. The body filling the seat is another plan's and
// has not arrived, so both controls reach the seat's reserved treatment, which says
// the editor has not been built rather than drawing a form that cannot save. That is
// a deliberate difference from a control whose VERB is unregistered, which this page
// still declines to draw: here the seat exists and the subject is real, and what is
// missing is a body this console does not author.
//
// THE THREE STANDING FACTS STAY. They need no wire to be true, they are what people
// get wrong about a registry like this one, and the third is what makes the delete
// question answerable at all.
//
// THE STATE IS NOT HERE. Everything this page holds — the read, the delete in
// flight, the refusal per row, and which record the seat is open on — lives in
// `definition-registry-view.ts`, because a state machine over the growth port and a
// body that renders what it settled on are two jobs. This file calls no port method
// and holds no `useState`: it reads one snapshot and hands presses back to the view.

import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import {
  DerivedFigure,
  InlineRefusal,
  Nothing,
  RefusalCard,
  WireFigure,
} from "../primitives/index.js";
import {
  useDefinitionSettlementAnnouncement,
  useSidekickRegistryView,
  type SidekickRegistrySnapshot,
  type SidekickRegistryView,
} from "./definition-registry-view.js";
import {
  NO_SAVED_SIDEKICKS,
  describeDeletionQuestion,
  type SidekickDefinitionRow,
} from "./definition-rows.js";
import {
  SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT,
  SidekickDefinitionRecordEditorMount,
} from "./DefinitionEditorSlot.js";

import "./definitions-page.css";

/** One standing fact about the registry, in the two halves a description list wants. */
interface SidekickRegistryRule {
  readonly term: string;
  readonly statement: string;
}

/**
 * The three facts, declared once and rendered in order.
 *
 * A list rather than three hand-written blocks so the page's claim — that there are
 * exactly three things to know before tuning one — is countable by a test rather
 * than asserted in a comment.
 */
const SIDEKICK_REGISTRY_RULES: readonly SidekickRegistryRule[] = [
  {
    term: "Where they live",
    statement:
      "On this machine, and nowhere else. There is no sharing, no sync, and nothing to export.",
  },
  {
    term: "What names them",
    statement:
      "A name is a label, not an identifier. Renaming a sidekick changes nothing that is already running under it.",
  },
  {
    term: "What editing reaches",
    statement:
      "Nothing already attached. A sidekick keeps the configuration it was given when it joined a session, for the rest of its life — so editing or deleting one here is safe.",
  },
];

export interface SidekickDefinitionsPageProps {
  readonly bridge: ConsoleBridge;
}

export function SidekickDefinitionsPage(props: SidekickDefinitionsPageProps): React.JSX.Element {
  const { view, snapshot } = useSidekickRegistryView(props.bridge);
  useDefinitionSettlementAnnouncement(snapshot.reading);

  return (
    <section className="meridian-sidekicks" aria-label="Sidekicks">
      <header className="meridian-sidekicks__head">
        <h2 className="meridian-sidekicks__title">Sidekicks</h2>
        <p className="meridian-sidekicks__lede">
          A sidekick you have tuned once — its provider, its instructions, its goal, the tools it
          may reach — kept so the next session starts from it instead of from nothing.
        </p>
        <button
          type="button"
          className="meridian-sidekicks__new"
          // Pressed rather than merely styled: the detail column is a single seat,
          // so which subject it is holding is state a person has to be able to read
          // — and a control that opens a region without saying it is the one that
          // opened it leaves the two columns looking unrelated.
          aria-pressed={snapshot.editorSubject?.kind === "new"}
          onClick={() => {
            view.openEditor({ kind: "new" });
          }}
        >
          New sidekick
        </button>
      </header>

      <dl className="meridian-sidekicks__rules">
        {SIDEKICK_REGISTRY_RULES.map((rule) => (
          <div className="meridian-sidekicks__rule" key={rule.term}>
            <dt className="meridian-sidekicks__rule-term">{rule.term}</dt>
            <dd className="meridian-sidekicks__rule-statement">{rule.statement}</dd>
          </div>
        ))}
      </dl>

      <div className="meridian-sidekicks__columns">
        <section className="meridian-sidekicks__column" aria-label="Saved sidekicks">
          <h3 className="meridian-sidekicks__column-title">Saved</h3>
          <SavedSidekicks snapshot={snapshot} view={view} />
        </section>

        <section className="meridian-sidekicks__column" aria-label="Sidekick detail">
          <h3 className="meridian-sidekicks__column-title">Detail</h3>
          <SidekickDefinitionRecordEditorMount
            slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
            subject={snapshot.editorSubject}
          />
        </section>
      </div>
    </section>
  );
}

/** The saved column's four answers, one per arm of the reading. */
function SavedSidekicks(props: {
  readonly snapshot: SidekickRegistrySnapshot;
  readonly view: SidekickRegistryView;
}): React.JSX.Element {
  const { snapshot, view } = props;
  const { reading } = snapshot;
  if (reading.kind === "not-loaded") {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading the sidekicks saved on this node."
      />
    );
  }
  if (reading.kind === "refused") {
    return <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  if (reading.kind === "empty") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={`${NO_SAVED_SIDEKICKS}.`}
        detail="Tuning one in a session and saving it puts it here, ready for the next session to start from."
      />
    );
  }
  return (
    <ul className="meridian-sidekicks__rows">
      {reading.rows.map((row) => (
        <li key={row.definitionId}>
          <SavedSidekickRow
            row={row}
            isArmed={snapshot.armedDeletionId === row.definitionId}
            isDeleting={snapshot.deletingId === row.definitionId}
            isAnyDeleteInFlight={snapshot.deletingId !== undefined}
            isOpenInEditor={
              snapshot.editorSubject?.kind === "stored" &&
              snapshot.editorSubject.definitionId === row.definitionId
            }
            refusal={snapshot.refusalByDefinitionId.get(row.definitionId)}
            view={view}
          />
        </li>
      ))}
    </ul>
  );
}

/** One saved sidekick: what it is, and the two things that can be done to it. */
function SavedSidekickRow(props: {
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
