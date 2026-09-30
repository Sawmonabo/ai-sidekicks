// One approval, one card, two answers.
//
// The Approvals View renders pending approval cards — category, requesting agent,
// summary of action, target scope, remembered-rule option — which is what this card
// carries. THAT THE REMEMBERING POLICY IS VISIBLE BEFORE THE ANSWER IS GIVEN is this
// component's own rule, because no committed document states it: an opt-in whose
// consequence is disclosed after the click is not an opt-in. Three properties this
// component keeps:
//
//   • **Two answers.** The contract's decision is `approved` or `rejected`, and
//     the card sends one of the two.
//   • **The opt-in is off, and an untouched control sends nothing.** The remembered
//     rule rides the approve path only, and `rememberedScope` is omitted from the
//     payload entirely rather than sent as a falsy member. Where the ask may not carry
//     a standing allow the control is absent. The control that composes it is
//     `RememberDecision.tsx`, co-located: it is a second responsibility.
//   • **Scope is never widened.** The answer names no scope of its own, so the daemon
//     applies the one the ask was raised with.
//
// The action row is a `toolbar` walked with arrows and with `h`/`l`, and both suppress
// the page scroll they would otherwise cause. Base UI supplies the disclosure under
// Meridian tokens — `@base-ui/react` is the one adopted widget library and ships zero
// CSS; the row itself is two ordinary buttons, because a library button would add
// weight without adding behavior a `<button>` does not already have.

import type {
  ApprovalDecision,
  ApprovalProjectionRow,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts";
import { useCallback, useId, useRef, useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ACCENT_FILL_CLASS } from "../../accent-fill.js";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { RefusalWithRemedy } from "../../components/RefusalWithRemedy/RefusalWithRemedy.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatClockTime } from "@renderer/lib/wire-figures.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { approvalAnswer, isApprovalAnswerable } from "../approval-offer.js";
import { ApprovalResource } from "./ApprovalResource.js";
import {
  APPROVAL_CATEGORY_LABELS,
  APPROVAL_STATE_LABELS,
} from "@renderer/lib/approval-vocabulary.js";
import { APPROVAL_STATE_TONES } from "../approval-state-tones.js";
import {
  IDLE_REMEMBERED_RULE_INTENT,
  RememberDecision,
  rememberedScopeFor,
} from "./RememberDecision.js";

import "./ApprovalCard.css";

export interface ApprovalCardProps {
  readonly record: ApprovalProjectionRow;
  /** True while this record's own resolve call is in flight. */
  readonly isResolving: boolean;
  /** The refusal this record's last answer came back with, if any. */
  readonly refusal: Refusal | undefined;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
  /**
   * Extra body between the header and the action row — where a permission-kind
   * `driver_ask` lands: a permission-kind ask normalizes into the approval model and
   * belongs to this view rather than to the transcript.
   */
  readonly children?: React.ReactNode;
}

/** The action row's members, in the order the arrows walk them. */
const ACTION_ORDER = ["approve", "reject"] as const;

/**
 * The one member of {@link ACTION_ORDER} that carries the accent, because a card
 * carries one filled primary action and no more. Named here rather than compared inline so the row
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
 *
 * @consumedBy the approval arrival announcement
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

/** One approval request: what it asks for, its state, and the controls that answer it. */
export function ApprovalCard(props: ApprovalCardProps): React.JSX.Element {
  const { record, onResolve } = props;
  const titleId = useId();
  const actionRowRef = useRef<HTMLDivElement>(null);
  const [rememberedGrantIntent, setRememberedGrantIntent] = useState(IDLE_REMEMBERED_RULE_INTENT);

  // The one offer reading, shared with this pane's palette rows: a refusal that
  // SETTLED this request takes the two actions off the card rather than leaving them
  // pressable, and takes the same two rows out of the palette in the same breath.
  // See `approval/approval-offer.ts` for why it is one function and not two.
  const answerable = isApprovalAnswerable(record, props.refusal);

  const answer = useCallback(
    (decision: ApprovalDecision) => {
      // The opt-in rides the approve path only, and an untouched control omits the
      // member rather than sending one the daemon would have to interpret.
      const remembered =
        decision === "approved"
          ? rememberedScopeFor(rememberedGrantIntent, record.subject)
          : undefined;
      onResolve(approvalAnswer(record, decision, remembered));
    },
    [onResolve, record, rememberedGrantIntent],
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
      data-approval-id={record.id}
    >
      <header className="meridian-approval-card__head">
        <h3 className="meridian-approval-card__title" id={titleId}>
          {APPROVAL_CATEGORY_LABELS[record.category]}
        </h3>
        <Chip mono label={record.category} tone="neutral" />
        <Chip
          label={APPROVAL_STATE_LABELS[record.state]}
          tone={APPROVAL_STATE_TONES[record.state]}
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
            <WireFigure value={record.scope} />
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
      </dl>

      {props.children}

      <Collapsible.Root className="meridian-approval-card__disclosure">
        <Collapsible.Trigger className="meridian-disclosure-trigger">
          What was asked for
        </Collapsible.Trigger>
        <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
          <ApprovalResource descriptor={record.resourceDescriptor} />
        </Collapsible.Panel>
      </Collapsible.Root>

      {answerable ? (
        <>
          {record.standingAllowOffered ? (
            <RememberDecision
              intent={rememberedGrantIntent}
              subject={record.subject}
              onChange={setRememberedGrantIntent}
            />
          ) : null}

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

      {props.refusal === undefined ? null : <RefusalWithRemedy refusal={props.refusal} />}
    </article>
  );
}

/**
 * The classes one action wears: the block, the shared action button at its regular
 * size, and a face — the filled accent on the primary action, the outline on the rest.
 */
function actionClassName(action: (typeof ACTION_ORDER)[number]): string {
  const base = `${APPROVAL_CARD_ACTION_CLASS} meridian-action-button meridian-action-button--regular`;
  return action === PRIMARY_ACTION
    ? `${base} ${ACCENT_FILL_CLASS}`
    : `${base} meridian-action-button--outline`;
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
