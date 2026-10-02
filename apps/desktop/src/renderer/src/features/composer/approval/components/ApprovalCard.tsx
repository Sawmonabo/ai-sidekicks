// One approval, one card, two answers (approve or reject). The remembering policy is visible
// before the answer, and an untouched remember control omits `rememberedScope` from the payload.
// The answer names no scope, so the daemon applies the one the ask was raised with.
// The action row is a `toolbar` walked with arrows and `h`/`l`, both suppressing page scroll.

import type {
  ApprovalDecision,
  ApprovalProjectionRow,
  ApprovalResolveRequest,
} from "@ai-sidekicks/contracts";
import { useCallback, useId, useRef, useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ACCENT_FILL_CLASS } from "../../accent-fill.js";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { clampedRowIndex } from "@renderer/hooks/useWindowedRovingIndex.js";
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

/** One approval record, whether its answer is in flight, and how the last one was refused. */
export interface ApprovalCardProps {
  readonly record: ApprovalProjectionRow;
  /** True while this record's own resolve call is in flight. */
  readonly isResolving: boolean;
  /** The refusal this record's last answer came back with, if any. */
  readonly refusal: Refusal | undefined;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
  /**
   * Extra body between the header and the action row, where a provider's permission ask is
   * framed.
   */
  readonly children?: React.ReactNode;
}

/** The action row's members, in the order the arrows walk them. */
const ACTION_ORDER = ["approve", "reject"] as const;

/** The one action that carries the accent: a card has one filled primary action. */
const PRIMARY_ACTION: (typeof ACTION_ORDER)[number] = "approve";

/**
 * The attribute a card carries its record's id on; the card writes it and
 * {@link findApprovalCardAction} reads it.
 */
const APPROVAL_CARD_ID_ATTRIBUTE = "data-approval-id";

const APPROVAL_CARD_ACTION_CLASS = "meridian-approval-card__action";

/**
 * The first action of the card for `approvalRequestId`, or `undefined`. The id is compared as a
 * string, never interpolated into a selector, because it is a wire value.
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

  // The offer reading shared with the palette rows: a refusal that settled this request takes
  // the actions off the card and the same two rows out of the palette.
  const answerable = isApprovalAnswerable(record, props.refusal);

  const answer = useCallback(
    (decision: ApprovalDecision) => {
      // The opt-in rides the approve path only; an untouched control omits the member.
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
    // An arrow in a toolbar is a movement; letting it also scroll would move the row away.
    event.preventDefault();
    const buttons = [...(actionRowRef.current?.querySelectorAll("button") ?? [])];
    const focusedAt = Math.max(
      buttons.findIndex((button) => button === document.activeElement),
      0,
    );
    // The walk stops at each end rather than wrapping around.
    const next = buttons[clampedRowIndex(focusedAt + step, buttons.length)];
    next?.focus();
  }, []);

  return (
    <article
      className="meridian-approval-card"
      aria-labelledby={titleId}
      // A JSX attribute name is syntax, so this spells out `APPROVAL_CARD_ID_ATTRIBUTE`.
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
            {/* `title` carries the exact instant the daemon sent. */}
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

/** The classes one action wears: the shared action button, then the accent fill or the outline. */
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
