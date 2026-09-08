import type { MembershipUpdate } from "@ai-sidekicks/contracts";
import { InlineRefusal, Nothing, formatCount } from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";
import { isLastRemainingOwner, type MembershipRow } from "./members-model.js";
import { type WireMutationSnapshot } from "../mutation-coordinator.js";
import { MembershipLedgerRow } from "./MembershipLedgerRow.js";

export function MembershipLedger(props: {
  readonly rows: readonly MembershipRow[];
  readonly mutation: WireMutationSnapshot;
  /**
   * Why no membership change may be sent right now, or `undefined` while none applies.
   *
   * Scoped to the CONTROLS and not to the ledger: the rows are the session's own
   * projection and an outage does not make them untrue.
   */
  readonly updateBlock: ShellMutationBlock | undefined;
  readonly onApply: (row: MembershipRow, update: MembershipUpdate) => void;
  readonly onDismissRefusal: (membershipId: string) => void;
}): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No membership has been read."
        detail="Roles and membership states come from the session's own event log, and this console has projected none for this session. There is no membership-list read to ask with either, so nobody asked — this is not an empty session."
      />
    );
  }
  return (
    <>
      <p className="meridian-members__count">
        {props.rows.length === 1
          ? "One membership."
          : `${formatCount(props.rows.length)} memberships.`}
      </p>
      {/* DISABLED WITH ITS CAUSE BESIDE IT, never hidden, on the provider-readiness
          row's precedent: a control that disappears while the runtime is away reads as
          a control this build does not have, and a disabled one with its sentence off
          screen reads as one that quietly stopped working. Through the console's one
          row-scoped refusal shape, because the block's two members ARE a code and a
          sentence. Said once above the rows rather than on each of them — the cause is
          the window's, and the rows below it are a projection the outage does not
          touch. */}
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
