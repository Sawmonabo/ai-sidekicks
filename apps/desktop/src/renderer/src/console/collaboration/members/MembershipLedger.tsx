import type { MembershipUpdate } from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  DerivedFigure,
  InlineRefusal,
  Nothing,
  PartialRead,
  formatCount,
} from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";
import { isLastRemainingOwner, type MembershipRow } from "./members-model.js";
import { type WireMutationSnapshot } from "../mutation-coordinator.js";
import { MembershipLedgerRow } from "./MembershipLedgerRow.js";

export function MembershipLedger(props: {
  readonly rows: readonly MembershipRow[];
  /** Why the membership roster read did not answer, where it did not. */
  readonly rosterRefusal: ConsoleRefusal | undefined;
  /**
   * True while this session's projection is behind: the rows are last-known.
   *
   * A line above the list and nothing more. What a person may DO to a membership is
   * the block below, which is a different fact from a different owner.
   */
  readonly isLastKnown: boolean;
  /**
   * Why a membership cannot be changed from this window right now, or `undefined`.
   *
   * The shell's own answer for `membership.update`, rendered as the refusal it is —
   * a code and a sentence — rather than paraphrased into a line of this surface's own
   * words. Absent is the ordinary state, including before anything has reported.
   */
  readonly updateBlock: ShellMutationBlock | undefined;
  readonly mutation: WireMutationSnapshot;
  readonly onApply: (row: MembershipRow, update: MembershipUpdate) => void;
  readonly onDismissRefusal: (membershipId: string) => void;
}): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No membership has been read."
        detail="Roles and membership states come from the session's own event log and from the membership roster read, and neither has stated one for this session. This is not an empty session."
      />
    );
  }
  return (
    <>
      {/* Above the rows and never instead of them: what the roster read withdraws is
          the claim that every row carries the identifier its controls need, not the
          rows themselves. `beside-an-answer` is the scope, because the log-derived
          rows on screen arrived some other way and are a fragment of unknown size. */}
      <PartialRead
        states={
          props.rosterRefusal === undefined
            ? []
            : [{ kind: "refused", scope: "beside-an-answer", refusal: props.rosterRefusal }]
        }
        subject="these memberships"
      />
      <p className="meridian-members__count">
        {props.rows.length === 1
          ? "One membership."
          : `${formatCount(props.rows.length)} memberships.`}
      </p>
      {props.isLastKnown ? (
        <p className="meridian-members__read-only" role="status">
          <DerivedFigure text="This session's projection is behind, so these rows are the last state this window was sent." />
        </p>
      ) : null}
      {props.updateBlock === undefined ? null : (
        <InlineRefusal code={props.updateBlock.code} detail={props.updateBlock.detail} />
      )}
      <ul className="meridian-members__rows">
        {props.rows.map((row) => (
          <li key={row.participantId}>
            <MembershipLedgerRow
              row={row}
              isLastOwner={isLastRemainingOwner(row, props.rows)}
              isPending={
                row.membershipId !== undefined && props.mutation.pendingKey === row.membershipId
              }
              // Every row's controls close while ANY row's change is unsettled,
              // not only the pending one's: the coordinator applies one at a time,
              // so a second row's control offers an act the surface would refuse.
              isAnyPending={props.mutation.pendingKey !== undefined}
              updateBlock={props.updateBlock}
              refusal={
                row.membershipId === undefined
                  ? undefined
                  : props.mutation.refusalByKey[row.membershipId]
              }
              onApply={(update) => {
                props.onApply(row, update);
              }}
              onDismissRefusal={() => {
                if (row.membershipId !== undefined) {
                  props.onDismissRefusal(row.membershipId);
                }
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
