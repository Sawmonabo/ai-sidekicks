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
//     rather than sent as a falsy member.
//   • **Scope is never widened.** The effective scope offered is the requested one;
//     this card renders no control that could broaden it.
//   • **Expiry is verbatim and arithmetic-free.** `expiryAt` is shown as the daemon
//     sent it, an absent one says "no expiry" in as many words, and nothing here
//     counts down or decides that a deadline has passed. `expired` and `canceled`
//     arrive from the wire or not at all.
//
// The action row is a `toolbar` walked with arrows and with `h`/`l`, and both
// suppress the page scroll they would otherwise cause. Base UI supplies the
// disclosure and the two form controls under Meridian tokens (§14.10); the row
// itself is two ordinary buttons, because a library button would add weight without
// adding behaviour a `<button>` does not already have.

import { useCallback, useId, useRef, useState } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import { Select } from "@base-ui/react/select";

import { Chip, DerivedFigure, InlineRefusal, WireFigure } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  hasCompleteResolvedQuad,
  isResolvedState,
  type ApprovalRecord,
} from "./approval-records.js";
import {
  CATEGORY_PHRASE,
  REMEMBERED_SCOPE_KINDS,
  SCOPE_KIND_PHRASE,
  STATE_PHRASE,
  STATE_TONE,
  asApprovalCategory,
  asApprovalState,
  type RememberedScopeKind,
} from "./approval-vocabulary.js";
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

export function ApprovalCard(props: ApprovalCardProps): React.JSX.Element {
  const { record, onResolve } = props;
  const titleId = useId();
  const actionRowRef = useRef<HTMLDivElement>(null);
  const [isRememberEngaged, setIsRememberEngaged] = useState(false);
  const [shouldRemember, setShouldRemember] = useState(false);
  const [rememberedScopeKind, setRememberedScopeKind] = useState<RememberedScopeKind>("run");

  const state = asApprovalState(record.state);
  const category = asApprovalCategory(record.category);
  const isPending = state === "pending";

  const answer = useCallback(
    (decision: "approved" | "rejected") => {
      // The opt-in rides the approve path only, and an untouched control omits the
      // member rather than sending one the daemon would have to interpret.
      const remembered =
        decision === "approved" && shouldRemember ? { kind: rememberedScopeKind } : undefined;
      onResolve({
        approvalRequestId: record.approvalRequestId,
        decision,
        effectiveScope: record.requestedScope,
        ...(remembered === undefined ? {} : { rememberedScope: remembered }),
      });
    },
    [
      onResolve,
      record.approvalRequestId,
      record.requestedScope,
      rememberedScopeKind,
      shouldRemember,
    ],
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
    <article className="meridian-approval-card" aria-labelledby={titleId}>
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
          <dt>Requested scope</dt>
          <dd>
            <WireFigure value={record.requestedScope} />
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

      {record.resourceDescriptor === undefined && record.auditMetadata === undefined ? null : (
        <Collapsible.Root className="meridian-approval-card__disclosure">
          <Collapsible.Trigger className="meridian-approval-card__disclosure-trigger">
            What was asked for
          </Collapsible.Trigger>
          <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
            {record.resourceDescriptor === undefined ? null : (
              <p className="meridian-approval-card__resource">
                <WireFigure value={record.resourceDescriptor} />
              </p>
            )}
            {record.auditMetadata === undefined
              ? null
              : Object.entries(record.auditMetadata).map(([key, value]) => (
                  <p className="meridian-approval-card__audit" key={key}>
                    <WireFigure value={key} />
                    <WireFigure value={value} />
                  </p>
                ))}
          </Collapsible.Panel>
        </Collapsible.Root>
      )}

      {isResolvedRecord(record) ? <ResolvedQuad record={record} /> : null}

      {isPending ? (
        <>
          <Collapsible.Root
            className="meridian-approval-card__remember"
            open={isRememberEngaged}
            onOpenChange={setIsRememberEngaged}
          >
            <Collapsible.Trigger className="meridian-approval-card__disclosure-trigger">
              Remember this answer
            </Collapsible.Trigger>
            <Collapsible.Panel className="meridian-approval-card__disclosure-panel">
              <p className="meridian-approval-card__remember-note">
                A remembered rule is an allow-rule, so it is minted only when you approve. It covers
                this category within the boundary you choose, and it can be revoked from the
                standing permissions list at any time.
              </p>
              <label className="meridian-approval-card__opt-in">
                <Checkbox.Root
                  className="meridian-approval-card__checkbox"
                  checked={shouldRemember}
                  onCheckedChange={setShouldRemember}
                >
                  <Checkbox.Indicator className="meridian-approval-card__checkbox-mark" />
                </Checkbox.Root>
                Remember my approval for this category
              </label>
              <Select.Root
                value={rememberedScopeKind}
                // The library types a clear as `null`; there is no cleared state
                // here, so a null is the current kind kept rather than a third
                // value the request would have to represent.
                onValueChange={(value: RememberedScopeKind | null) => {
                  if (value !== null) {
                    setRememberedScopeKind(value);
                  }
                }}
              >
                <Select.Trigger
                  className="meridian-approval-card__scope-trigger"
                  aria-label="Remembered scope"
                  disabled={!shouldRemember}
                >
                  <Select.Value />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup className="meridian-approval-card__scope-popup">
                      {REMEMBERED_SCOPE_KINDS.map((kind) => (
                        <Select.Item
                          className="meridian-approval-card__scope-item"
                          key={kind}
                          value={kind}
                        >
                          <Select.ItemText>{SCOPE_KIND_PHRASE[kind]}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </Collapsible.Panel>
          </Collapsible.Root>

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
                className={`meridian-approval-card__action meridian-approval-card__action--${action}`}
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
            <WireFigure value={record.rememberedScope} />
          </dd>
        </div>
      )}
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
