// One approval, one card, two answers.
//
// `Spec-023 §Signature Feature Composition Sketches`' Approvals View renders
// "pending approval cards (category, requesting agent, summary of action, target
// scope, remembered-rule option)", which is what this card carries. THAT THE
// REMEMBERING POLICY IS VISIBLE BEFORE THE ANSWER IS GIVEN is this component's own
// rule, because no committed document states it: an opt-in whose consequence is
// disclosed after the click is not an opt-in. Four properties
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
// disclosure under Meridian tokens — `Spec-023 §Console Libraries` adopts
// `@base-ui/react` as "the one widget family … with zero CSS"; the row itself is two ordinary buttons,
// because a library button would add weight without adding behaviour a `<button>`
// does not already have.

import { useCallback, useId, useRef, useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ACCENT_FILL_CLASS,
  Chip,
  DerivedFigure,
  RemediedRefusal,
  WireFigure,
  formatClockTime,
} from "../../../primitives/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { isApprovalAnswerable } from "../approval-offer.js";
import { ApprovalResource } from "./ApprovalResource.js";
import { isResolvedState, type ApprovalRecord } from "../../../bridge/index.js";
import {
  CATEGORY_PHRASE,
  STATE_PHRASE,
  STATE_TONE,
  asApprovalCategory,
  asApprovalState,
} from "../../../bridge/index.js";
import {
  IDLE_REMEMBERED_GRANT_INTENT,
  RememberDecision,
  rememberedScopeFor,
} from "./RememberDecision.js";
import { type ApprovalResolveRequest } from "../approvals-wire.js";
import { ResolvedQuad } from "./ResolvedQuad.js";

export interface ApprovalCardProps {
  readonly record: ApprovalRecord;
  /** True while this record's own resolve call is in flight. */
  readonly isResolving: boolean;
  /** The refusal this record's last answer came back with, if any. */
  readonly refusal: ConsoleRefusal | undefined;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
  /**
   * Extra body between the header and the action row — where a permission-kind
   * `driver_ask` lands, which `Spec-023 §Signature Feature Composition Sketches`'
   * Timeline View sends here: it "normalizes into the approval model and belongs to
   * the Approvals View".
   */
  readonly children?: React.ReactNode;
}

/** The action row's members, in the order the arrows walk them. */
const ACTION_ORDER = ["approve", "reject"] as const;

/**
 * The one member of {@link ACTION_ORDER} that carries the accent, per rule 1's one
 * primary action per surface. Named here rather than compared inline so the row
 * cannot grow a second filled control without this line moving.
 */
const PRIMARY_ACTION: (typeof ACTION_ORDER)[number] = "approve";

/**
 * The attribute a card carries its record's identity on, and the class its actions
 * wear. Both sides of one seam live here: the card writes them and
 * {@link findApprovalCardAction} reads them, so neither can be renamed alone.
 */
const APPROVAL_CARD_ID_ATTRIBUTE = "data-approval-id";

const APPROVAL_CARD_ACTION_CLASS = "meridian-approval-card__action";

/**
 * The classes one action wears: the block, its own modifier, and — on the primary
 * action alone — the primitives' filled-accent face.
 */
function actionClassName(action: (typeof ACTION_ORDER)[number]): string {
  const base = `${APPROVAL_CARD_ACTION_CLASS} ${APPROVAL_CARD_ACTION_CLASS}--${action}`;
  return action === PRIMARY_ACTION ? `${base} ${ACCENT_FILL_CLASS}` : base;
}

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
  // The one offer reading, shared with this pane's palette rows: a refusal that
  // SETTLED this request takes the two actions off the card rather than leaving them
  // pressable, and takes the same two rows out of the palette in the same breath.
  // See `approvals/pane/approval-offer.ts` for why it is one function and not two.
  const answerable = isApprovalAnswerable(record, props.refusal);

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
          <ApprovalResource descriptor={record.resourceDescriptor} />
        </Collapsible.Panel>
      </Collapsible.Root>

      {isResolvedRecord(record) ? <ResolvedQuad record={record} /> : null}

      {answerable ? (
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
                className={actionClassName(action)}
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

      {props.refusal === undefined ? null : <RemediedRefusal refusal={props.refusal} />}
    </article>
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
