// One approval, one card, two answers.
//
// `Spec-023 §Console Design (Meridian)` §7.6: the card carries category, requesting
// actor, requested resource, target scope, and the remembered-rule option, with the
// policy that will remember it visible BEFORE the answer is given. Four properties
// this component keeps that are worth naming because each one is a Never:
//
//   • **Two answers, no third.** `APPROVAL_DECISIONS` is closed at two and there is
//     no amend control, because `ApprovalResolveRequest` carries nothing that edits
//     the requested action. The absence is structural, not a TODO.
//   • **The opt-in is off, and an untouched control sends nothing.** A remembered
//     scope is valid only on an `approved` decision, so the disclosure is absent on
//     the reject path and `rememberedScope` is omitted from the payload entirely
//     rather than sent as a falsy member. The control that composes it is
//     `RememberDecision.tsx`, co-located: it is a second responsibility, and this
//     file is at the size the package splits at.
//   • **Scope is never widened.** The effective scope offered is the requested one;
//     this card renders no control that could broaden it.
//   • **Expiry is verbatim and arithmetic-free.** `expiryAt` is shown as the daemon
//     sent it, an absent one says "no expiry" in as many words, and nothing here
//     counts down or decides that a deadline has passed. `expired` and `canceled`
//     arrive from the wire or not at all.
//
// The action row is a `toolbar` walked with arrows and with `h`/`l`, and both
// suppress the page scroll they would otherwise cause. Base UI supplies the
// disclosure under Meridian tokens (§14.10); the row itself is two ordinary buttons,
// because a library button would add weight without adding behaviour a `<button>`
// does not already have.

import { useCallback, useId, useRef, useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";

import {
  Chip,
  DerivedFigure,
  InlineRefusal,
  WireFigure,
  formatClockTime,
  formatWireDescriptor,
} from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  hasCompleteResolvedQuad,
  isResolvedState,
  type ApprovalRecord,
} from "./approval-records.js";
import {
  CATEGORY_PHRASE,
  STATE_PHRASE,
  STATE_TONE,
  asApprovalCategory,
  asApprovalState,
  rememberedScopeKindPhrase,
} from "./approval-vocabulary.js";
import {
  IDLE_REMEMBERED_GRANT_INTENT,
  RememberDecision,
  rememberedScopeFor,
} from "./RememberDecision.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";

export interface ApprovalCardProps {
  readonly record: ApprovalRecord;
  /** True while this record's own resolve call is in flight. */
  readonly isResolving: boolean;
  /** The refusal this record's last answer came back with, if any. */
  readonly refusal: ConsoleRefusal | undefined;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
  /** Extra body between the header and the action row — §7.8's normalized input. */
  readonly children?: React.ReactNode;
}

/** The action row's members, in the order the arrows walk them. */
const ACTION_ORDER = ["approve", "reject"] as const;

/**
 * The attribute a card carries its record's identity on, and the class its actions
 * wear. Both sides of one seam live here: the card writes them and
 * {@link findApprovalCardAction} reads them, so neither can be renamed alone.
 */
const APPROVAL_CARD_ID_ATTRIBUTE = "data-approval-id";
const APPROVAL_CARD_ACTION_CLASS = "meridian-approval-card__action";

/**
 * The first action of ONE card, found by the record it belongs to.
 *
 * Here rather than at a caller because the selector is this component's own markup.
 * A caller reaching for the first action in DOM order gets an older card's button
 * whenever more than one is rendered — which is the whole reason a caller needs to
 * name a record at all.
 *
 * The identity is compared as a string rather than interpolated into a selector: an
 * approval id is a wire value, and a value that reaches a query as syntax is a value
 * that can be malformed there.
 */
export function findApprovalCardAction(
  root: ParentNode,
  approvalRequestId: string,
): HTMLElement | undefined {
  for (const card of root.querySelectorAll(`[${APPROVAL_CARD_ID_ATTRIBUTE}]`)) {
    if (card.getAttribute(APPROVAL_CARD_ID_ATTRIBUTE) !== approvalRequestId) {
      continue;
    }
    const action = card.querySelector(`.${APPROVAL_CARD_ACTION_CLASS}`);
    return action instanceof HTMLElement ? action : undefined;
  }
  return undefined;
}

export function ApprovalCard(props: ApprovalCardProps): React.JSX.Element {
  const { record, onResolve } = props;
  const titleId = useId();
  const actionRowRef = useRef<HTMLDivElement>(null);
  const [rememberedGrantIntent, setRememberedGrantIntent] = useState(IDLE_REMEMBERED_GRANT_INTENT);

  const state = asApprovalState(record.state);
  const category = asApprovalCategory(record.category);
  const isPending = state === "pending";

  const answer = useCallback(
    (decision: "approved" | "rejected") => {
      // The opt-in rides the approve path only, and an untouched control omits the
      // member rather than sending one the daemon would have to interpret.
      const remembered =
        decision === "approved" ? rememberedScopeFor(rememberedGrantIntent) : undefined;
      onResolve({
        approvalRequestId: record.approvalRequestId,
        decision,
        effectiveScope: record.requestedScope,
        ...(remembered === undefined ? {} : { rememberedScope: remembered }),
      });
    },
    [onResolve, record.approvalRequestId, record.requestedScope, rememberedGrantIntent],
  );

  const onActionKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = movementStep(event.key);
    if (step === 0) {
      return;
    }
    // Suppressed deliberately: an arrow inside a toolbar is a movement, and letting
    // it also scroll the pane moves the row out from under the person using it.
    event.preventDefault();
    const buttons = [...(actionRowRef.current?.querySelectorAll("button") ?? [])];
    const focusedAt = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[(Math.max(focusedAt, 0) + step + buttons.length) % buttons.length];
    next?.focus();
  }, []);

  return (
    <article
      className="meridian-approval-card"
      aria-labelledby={titleId}
      // The written form of `APPROVAL_CARD_ID_ATTRIBUTE` above; a JSX attribute
      // name is syntax and cannot be the constant itself. The pane's focus test
      // fails the moment the two stop agreeing, which is what holds them together.
      data-approval-id={record.approvalRequestId}
    >
      <header className="meridian-approval-card__head">
        <h3 className="meridian-approval-card__title" id={titleId}>
          {category === undefined ? "Unrecognized category" : CATEGORY_PHRASE[category]}
        </h3>
        <Chip mono label={record.category} tone={category === undefined ? "failure" : "neutral"} />
        <Chip
          label={state === undefined ? record.state : STATE_PHRASE[state]}
          tone={state === undefined ? "failure" : STATE_TONE[state]}
        />
      </header>

      <dl className="meridian-approval-card__facts">
        <div className="meridian-approval-card__fact">
          <dt>Requested by</dt>
          <dd>
            <WireFigure value={record.requestedBy} />
          </dd>
        </div>
        <div className="meridian-approval-card__fact">
          <dt>Raised by run</dt>
          <dd>
            <WireFigure value={record.runId} />
          </dd>
        </div>
        <div className="meridian-approval-card__fact">
          <dt>Requested scope</dt>
          <dd>
            <WireFigure value={record.requestedScope} />
          </dd>
        </div>
        <div className="meridian-approval-card__fact">
          <dt>Requested</dt>
          <dd>
            {/* The clock reading is what a person reads; `title` carries the exact
                instant the daemon sent, because a formatted figure never hides it. */}
            <WireFigure value={formatClockTime(record.createdAt)} title={record.createdAt} />
          </dd>
        </div>
        <div className="meridian-approval-card__fact">
          <dt>Last changed</dt>
          <dd>
            <WireFigure value={formatClockTime(record.updatedAt)} title={record.updatedAt} />
          </dd>
        </div>
        <div className="meridian-approval-card__fact">
          <dt>Expires</dt>
          <dd>
            {record.expiryAt === undefined ? (
              <DerivedFigure text="No expiry" />
            ) : (
              <WireFigure value={record.expiryAt} />
            )}
          </dd>
        </div>
      </dl>

      {props.children}

      <Collapsible.Root className="meridian-approval-card__disclosure">
        <Collapsible.Trigger className="meridian-approval-card__disclosure-trigger">
          What was asked for
        </Collapsible.Trigger>
        <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
          <ResourceDescriptor descriptor={record.resourceDescriptor} />
        </Collapsible.Panel>
      </Collapsible.Root>

      {isResolvedRecord(record) ? <ResolvedQuad record={record} /> : null}

      {isPending ? (
        <>
          <RememberDecision intent={rememberedGrantIntent} onChange={setRememberedGrantIntent} />

          <div
            className="meridian-approval-card__actions"
            ref={actionRowRef}
            role="toolbar"
            aria-label="Answer this request"
            aria-orientation="horizontal"
            onKeyDown={onActionKeyDown}
          >
            {ACTION_ORDER.map((action) => (
              <button
                className={`${APPROVAL_CARD_ACTION_CLASS} ${APPROVAL_CARD_ACTION_CLASS}--${action}`}
                key={action}
                type="button"
                disabled={props.isResolving}
                onClick={() => {
                  answer(action === "approve" ? "approved" : "rejected");
                }}
              >
                {action === "approve" ? "Approve" : "Reject"}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {props.refusal === undefined ? null : <InlineRefusal {...props.refusal} />}
    </article>
  );
}

/** The resolved quad, and the one honest thing to say when it is incomplete. */
function ResolvedQuad(props: { readonly record: ApprovalRecord }): React.JSX.Element {
  const { record } = props;
  if (!hasCompleteResolvedQuad(record)) {
    return (
      <p className="meridian-approval-card__incomplete">
        This record is resolved and the reply did not carry every part of its resolution, so what is
        shown is less than what happened.
      </p>
    );
  }
  return (
    <dl className="meridian-approval-card__facts meridian-approval-card__facts--resolved">
      <div className="meridian-approval-card__fact">
        <dt>Resolved at</dt>
        <dd>
          <WireFigure value={record.resolvedAt ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Decision</dt>
        <dd>
          <WireFigure value={record.decision ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Approver</dt>
        <dd>
          <WireFigure value={record.approverId ?? ""} />
        </dd>
      </div>
      <div className="meridian-approval-card__fact">
        <dt>Effective scope</dt>
        <dd>
          <WireFigure value={record.effectiveScope ?? ""} />
        </dd>
      </div>
      {record.rememberedScope === undefined ? null : (
        <div className="meridian-approval-card__fact">
          <dt>Remembered scope</dt>
          <dd>
            <DerivedFigure text={rememberedScopeKindPhrase(record.rememberedScope.kind)} />
            {record.rememberedScope.pattern === undefined ? (
              <DerivedFigure text="the whole category inside that boundary" />
            ) : (
              <WireFigure value={record.rememberedScope.pattern} />
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The requested resource, as the structured value the reply carries.
 *
 * The member is required on the wire, so "no descriptor" is not a state a
 * conformant row can be in — a row missing it never parses and is counted
 * unreadable instead. What IS reachable is a descriptor carrying no members at all,
 * and that is said in as many words rather than rendered as a blank panel.
 */
function ResourceDescriptor(props: {
  readonly descriptor: Readonly<Record<string, unknown>>;
}): React.JSX.Element {
  const entries = formatWireDescriptor(props.descriptor);
  if (entries.length === 0) {
    return (
      <p className="meridian-approval-card__resource-empty">
        The reply carried a descriptor with nothing in it, so what will actually run is not shown
        here.
      </p>
    );
  }
  return (
    <dl className="meridian-approval-card__resource">
      {entries.map((entry) => (
        <div className="meridian-approval-card__resource-member" key={entry.key}>
          <dt>
            <WireFigure value={entry.key} />
          </dt>
          <dd>
            <WireFigure value={entry.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function isResolvedRecord(record: ApprovalRecord): boolean {
  return isResolvedState(record.state);
}

/** Arrow and vim movement, and nothing else. `0` means this key is not ours. */
function movementStep(key: string): number {
  if (key === "ArrowRight" || key === "l") {
    return 1;
  }
  if (key === "ArrowLeft" || key === "h") {
    return -1;
  }
  return 0;
}
