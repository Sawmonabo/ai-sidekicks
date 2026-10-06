// One approval, one card, three answers in a fixed order: `Decline`, `Always allow <subject> this
// session` and `Approve once`, the primary last. The middle answer is the rule: its face remembers
// it for this session and its arrow for the whole project, and it is absent where the ask may not
// carry a standing allow. On a network ask `Decline` carries an arrow that blocks the host for the
// session. `Approve once` and a plain `Decline` send no `rememberedScope`. The answer names no
// scope, so the daemon applies the one the ask was raised with. The faces are a `toolbar` walked
// with arrows and `h`/`l`, both suppressing page scroll.

import type {
  ApprovalDecision,
  ApprovalProjectionRow,
  ApprovalResolveRequest,
  RememberedScope,
} from "@ai-sidekicks/contracts/approval";
import { useCallback, useId, useRef } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { isHTMLElement } from "@floating-ui/utils/dom";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { clampedRowIndex } from "#renderer/hooks/useWindowedRovingIndex.js";
import { RefusalWithRemedy } from "../../components/RefusalWithRemedy/RefusalWithRemedy.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatClockTime } from "#renderer/lib/wire/figures.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { approvalAnswer, isApprovalAnswerable } from "../offer.js";
import { ApprovalResource } from "./ApprovalResource.js";
import {
  APPROVAL_CATEGORY_LABELS,
  APPROVAL_STATE_LABELS,
  RULE_SCOPE_LABELS,
} from "#renderer/lib/approval-vocabulary.js";
import { APPROVAL_STATE_TONES } from "../state-tones.js";
import {
  APPROVAL_CARD_ACTION_CLASS,
  ScopedAnswer,
  type ScopedAnswerArrow,
} from "./ScopedAnswer.js";

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

/**
 * The attribute a card carries its record's id on; the card writes it and
 * {@link findApprovalCardAction} reads it.
 */
const APPROVAL_CARD_ID_ATTRIBUTE = "data-approval-id";

/** The class only `Approve once` wears, where an arriving card's focus lands. */
const APPROVE_ONCE_CLASS = "meridian-approval-card__approve-once";

/** The faces' shared size; each adds its own look. */
const ANSWER_FACE_CLASS = "meridian-action-button meridian-action-button--regular";

/** `Decline`'s look: an outline marked red. */
const DECLINE_FACE_CLASS = "meridian-action-button--outline meridian-action-button--destructive";

/**
 * The `Approve once` action of the card for `approvalRequestId`, or `undefined`. The id is
 * compared as a string, never interpolated into a selector, because it is a wire value.
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
    const action = card.querySelector(`.${APPROVE_ONCE_CLASS}`);
    return isHTMLElement(action) ? action : undefined;
  }
  return undefined;
}

/** One approval request: what it asks for, its state, and the controls that answer it. */
export function ApprovalCard(props: ApprovalCardProps): React.JSX.Element {
  const { record, onResolve } = props;
  const titleId = useId();
  const actionRowRef = useRef<HTMLDivElement>(null);

  // The offer reading shared with the palette rows: a refusal that settled this request takes
  // the actions off the card and the same two rows out of the palette.
  const answerable = isApprovalAnswerable(record, props.refusal);

  const answer = useCallback<ApprovalAnswerPress>(
    (decision, remembered) => {
      onResolve(approvalAnswer(record, decision, remembered));
    },
    [onResolve, record],
  );

  const onActionKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = movementStep(event.key);
    if (step === 0) {
      return;
    }
    // The faces alone are walked; an arrow beside a face, and its open menu, keep their keys.
    const faces = [
      ...(actionRowRef.current?.querySelectorAll<HTMLElement>(`.${APPROVAL_CARD_ACTION_CLASS}`) ??
        []),
    ];
    const focusedAt = faces.findIndex((face) => face === face.ownerDocument.activeElement);
    if (focusedAt < 0) {
      return;
    }
    // An arrow in a toolbar is a movement; letting it also scroll would move the row away.
    event.preventDefault();
    // The walk stops at each end rather than wrapping around.
    const next = faces[clampedRowIndex(focusedAt + step, faces.length)];
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
        <div
          className="meridian-approval-card__actions"
          ref={actionRowRef}
          role="toolbar"
          aria-label="Answer this request"
          aria-orientation="horizontal"
          onKeyDown={onActionKeyDown}
        >
          <ScopedAnswer
            label="Decline"
            faceClassName={`${ANSWER_FACE_CLASS} ${DECLINE_FACE_CLASS}`}
            isDisabled={props.isResolving}
            onPress={() => {
              answer("rejected", undefined);
            }}
            arrow={declineArrowFor(record, answer)}
          />
          {record.standingAllowOffered ? (
            <ScopedAnswer
              label={allowLabelFor(record)}
              faceClassName={`${ANSWER_FACE_CLASS} meridian-action-button--outline`}
              isDisabled={props.isResolving}
              onPress={() => {
                answer("approved", ruleFor(record, "session", "allow"));
              }}
              arrow={allowArrowFor(record, answer)}
            />
          ) : null}
          <ScopedAnswer
            label="Approve once"
            faceClassName={`${ANSWER_FACE_CLASS} meridian-accent-fill ${APPROVE_ONCE_CLASS}`}
            isDisabled={props.isResolving}
            onPress={() => {
              answer("approved", undefined);
            }}
          />
        </div>
      ) : null}

      {props.refusal === undefined ? null : <RefusalWithRemedy refusal={props.refusal} />}
    </article>
  );
}

/** One press of the card: a decision and the rule it makes, if any. */
type ApprovalAnswerPress = (
  decision: ApprovalDecision,
  remembered: RememberedScope | undefined,
) => void;

/** The rule a press makes on the ask's own subject. */
function ruleFor(
  record: ApprovalProjectionRow,
  kind: RememberedScope["kind"],
  sense: RememberedScope["sense"],
): RememberedScope {
  return { kind, pattern: record.subject, sense };
}

function allowLabelFor(record: ApprovalProjectionRow): string {
  return `Always allow ${record.subject} ${RULE_SCOPE_LABELS.session}`;
}

/** `Decline`'s arrow, on a network ask only: a host is the one subject a refusal is kept for. */
function declineArrowFor(
  record: ApprovalProjectionRow,
  answer: ApprovalAnswerPress,
): ScopedAnswerArrow | undefined {
  if (record.category !== "network_access") {
    return undefined;
  }
  return {
    label: "Other ways to decline",
    rows: [
      {
        label: `Block ${record.subject} ${RULE_SCOPE_LABELS.session}`,
        isFacePress: false,
        onPress: () => {
          answer("rejected", ruleFor(record, "session", "block"));
        },
      },
    ],
  };
}

/** The standing allow's arrow, where the rule may also be written for the whole project. */
function allowArrowFor(
  record: ApprovalProjectionRow,
  answer: ApprovalAnswerPress,
): ScopedAnswerArrow | undefined {
  if (!record.projectScopeOffered) {
    return undefined;
  }
  return {
    label: "Other scopes for this rule",
    rows: [
      {
        label: allowLabelFor(record),
        isFacePress: true,
        onPress: () => {
          answer("approved", ruleFor(record, "session", "allow"));
        },
      },
      {
        label: `Always in ${RULE_SCOPE_LABELS.project}`,
        isFacePress: false,
        onPress: () => {
          answer("approved", ruleFor(record, "project", "allow"));
        },
      },
    ],
  };
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
