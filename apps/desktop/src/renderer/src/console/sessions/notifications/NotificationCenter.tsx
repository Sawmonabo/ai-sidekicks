// The notification center: one place that answers "what needs me".
//
// `Spec-023 §Console Design (Meridian)` §Notification center and the attention
// plane. Three of its rules decide the shape of this file more than the layout
// does:
//
//   • **It offers no dismiss.** The contract has no dismiss method and no
//     client-writable resolution field, and `Spec-019 §Required Behavior` makes
//     emission derived from canonical state rather than from client heuristics — a
//     dismiss-all control would be exactly that heuristic. An item clears when the
//     daemon sets `resolvedAt`; opening one navigates and resolves nothing.
//   • **Mute is global only.** `Spec-023 §Default Behavior` allows a per-session
//     mute and `Spec-019 §Resolved Questions and V1 Scope Decisions` makes
//     preferences global in the first release. The conflict resolves to the
//     notification owner: the global control ships and the per-session control is
//     ABSENT rather than disabled, because a disabled control is a claim that the
//     capability exists.
//   • **It re-filters nothing.** Non-matching events are dropped at the control
//     plane before emission (`Spec-019 §Desktop-to-Desktop Delivery`), so a second
//     filter here would be a second authority on a decision already made.
//
// WHAT IS ON SCREEN TODAY. The projection read (`attention.projectionRead`) is
// registered in the corpus and absent from `packages/contracts`, from the preload
// bridge, and from the growth port — so the destination reads through
// `READS_NO_ATTENTION_PROJECTION`, which answers "nothing was read", and the
// honest render of that is the `not-checked` kind of nothing rather than the
// all-clear line. Those two are the conflation the five kinds of nothing exist to
// prevent: one says the console did not ask, the other says a person is free.
//
// THIS COMPONENT PERFORMS NO READ. It is handed the reading, because the
// all-sessions list beside it takes each row's severity off the same plane and two
// reads would eventually disagree about one question.
//
// The preference controls are absent for the same reason and it is stated on
// screen: `attention.preferenceRead` / `attention.preferenceUpdate` are
// control-plane procedures the console cannot reach, so the center says where mute
// lives rather than drawing a switch that would write nowhere.

import type { AttentionItem, AttentionTrigger } from "../../bridge/index.js";
import {
  Chip,
  Nothing,
  RefusalCard,
  WireFigure,
  formatClockTime,
  formatCount,
} from "../../primitives/index.js";
import type { AttentionReading, AttentionSessionGroup } from "./attention-plane.js";

/**
 * How one trigger reads. Total over the closed six by construction, so a seventh
 * fails to compile here before it can reach a surface that renders it namelessly.
 *
 * The label is the console's own reading of a wire value; the item's `summary` is
 * the projection's own text and is rendered beside it verbatim. Exactly one of the
 * six earns red and a glyph — the one that names a failure — so the two-hue rule
 * holds: amber means a person is needed, red means something failed, and every
 * other trigger carries whichever of those its severity says and no colour of its
 * own.
 */
const TRIGGER_LABELS: Readonly<Record<AttentionTrigger, string>> = {
  pending_approval: "Waiting on an approval",
  pending_input: "Waiting on your input",
  run_completed: "A run finished",
  run_failed: "A run failed",
  invite_received: "An invitation arrived",
  mention: "You were mentioned",
};

export interface NotificationCenterProps {
  /**
   * The projection read's result. The destination performs the read and hands it
   * here, so the center and the all-sessions list read one plane and cannot
   * disagree about what needs a person.
   */
  readonly reading: AttentionReading;
  /** Open the source of one item. Renderer-local navigation; resolves nothing. */
  readonly onOpen?: (item: AttentionItem) => void;
}

export function NotificationCenter(props: NotificationCenterProps): React.JSX.Element {
  return (
    <section className="meridian-attention" aria-label="Attention">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Needs you</h2>
        <p className="meridian-attention__mute">
          Muting is a single global setting, and it never hides work that is blocking.
        </p>
      </header>
      <ProjectionBody reading={props.reading} onOpen={props.onOpen} />
    </section>
  );
}

function ProjectionBody(props: {
  readonly reading: AttentionReading;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  if (props.reading.phase === "reading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading what needs you." />;
  }
  if (props.reading.phase === "not-asked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The attention projection has not been read."
        detail="Nothing on the installed bridge reads it yet, so this console has not asked. It is not an all-clear — an all-clear is an answer, and no question was put."
      />
    );
  }
  if (props.reading.phase === "refused") {
    // The read was put and it failed, which is neither an all-clear nor a question
    // nobody asked. The refusal renders with its own code, verbatim.
    return <RefusalCard code={props.reading.refusal.code} detail={props.reading.refusal.detail} />;
  }
  const { plane, droppedCount } = props.reading;
  if (plane.groups.length === 0) {
    // Nothing survived the boundary. WHY nothing survived decides which absence
    // this is: a read that answered with an empty projection is an all-clear, and
    // a read every member of which the boundary rejected is the console failing to
    // recognise an answer it did receive. Reporting the second as the first is the
    // conflation the five kinds of nothing exist to prevent — it tells a person
    // they are free on the strength of a read nobody could parse.
    return droppedCount === 0 ? (
      <Nothing
        kind="empty"
        placement="surface"
        title="Nothing needs you."
        detail="Approvals, questions, finished runs, invitations, and mentions all appear here while they are unresolved."
      />
    ) : (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Nothing in that read could be recognised."
        detail={unrecognisedItemsSentence(droppedCount)}
      />
    );
  }
  return (
    <>
      <ul className="meridian-attention__groups">
        {plane.groups.map((group) => (
          <li key={group.sessionId}>
            <SessionGroup
              group={group}
              foldInformational={plane.hasActionable}
              onOpen={props.onOpen}
            />
          </li>
        ))}
      </ul>
      {droppedCount === 0 ? null : (
        <p className="meridian-attention__dropped" role="status">
          {unrecognisedItemsSentence(droppedCount)}
        </p>
      )}
    </>
  );
}

/**
 * What the console says about members its boundary refused.
 *
 * One sentence with two homes — beside the groups a partial read produced, and as
 * the whole body of a read that produced none — so the two can never drift into
 * saying different things about one number. It names the SHAPE rather than one
 * cause, because the boundary drops on several: a trigger or severity outside its
 * closed set, a missing required member, and an optional member the producer sent
 * that could not be read.
 */
function unrecognisedItemsSentence(droppedCount: number): string {
  return droppedCount === 1
    ? "One item in that read did not match the shape this console recognises, and was not shown."
    : `${formatCount(droppedCount)} items in that read did not match the shape this console recognises, and were not shown.`;
}

/**
 * One session's items, actionable above informational.
 *
 * The informational half folds under a count while ANY session has actionable
 * attention — the design's density rule — and the fold is a `<details>` rather
 * than a control this component tracks state for: the platform element is
 * keyboard-reachable, announces its own expanded state, and costs no render pass
 * to open.
 */
function SessionGroup(props: {
  readonly group: AttentionSessionGroup;
  readonly foldInformational: boolean;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { group } = props;
  const informational = <AttentionItemList items={group.informational} onOpen={props.onOpen} />;
  return (
    <section className="meridian-attention__group" aria-label={`Attention in ${group.sessionId}`}>
      <h3 className="meridian-attention__group-title">
        <WireFigure value={group.sessionId} />
      </h3>
      <AttentionItemList items={group.actionable} onOpen={props.onOpen} />
      {group.informational.length === 0 || !props.foldInformational ? (
        informational
      ) : (
        <details className="meridian-attention__fold">
          <summary className="meridian-attention__fold-summary">
            {`${formatCount(group.informational.length)} informational`}
          </summary>
          {informational}
        </details>
      )}
    </section>
  );
}

/** Zero or more items as one list. Zero renders nothing, never an empty list. */
function AttentionItemList(props: {
  readonly items: readonly AttentionItem[];
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element | null {
  if (props.items.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-attention__items">
      {props.items.map((item) => (
        <li key={item.id}>
          <AttentionRow item={item} onOpen={props.onOpen} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One item.
 *
 * Rendered as a button when the surface supplied a way to open it and as plain
 * text otherwise, so the console never offers a press that goes nowhere. The
 * scope reads off `runId` exactly as the projection discriminates it: an item
 * carrying one is that run's, an item without one is the session's aggregate,
 * and the console labels which without recomputing either.
 */
function AttentionRow(props: {
  readonly item: AttentionItem;
  readonly onOpen: ((item: AttentionItem) => void) | undefined;
}): React.JSX.Element {
  const { item, onOpen } = props;
  const body = (
    <>
      <span className="meridian-attention__row-head">
        {item.trigger === "run_failed" ? (
          <Chip tone="failure" label={TRIGGER_LABELS[item.trigger]} glyph="alert" />
        ) : (
          <Chip
            tone={item.severity === "actionable" ? "attention" : "neutral"}
            label={TRIGGER_LABELS[item.trigger]}
          />
        )}
        <WireFigure value={formatClockTime(item.createdAt)} title={item.createdAt} />
      </span>
      <span className="meridian-attention__row-summary">{item.summary}</span>
      <span className="meridian-attention__row-scope">
        {item.runId === undefined ? (
          "Everything unresolved in this session"
        ) : (
          <WireFigure value={item.runId} />
        )}
      </span>
    </>
  );
  if (onOpen === undefined) {
    return <div className="meridian-attention__row">{body}</div>;
  }
  return (
    <button
      type="button"
      className="meridian-attention__row meridian-attention__row--open"
      onClick={() => {
        onOpen(item);
      }}
    >
      {body}
    </button>
  );
}
