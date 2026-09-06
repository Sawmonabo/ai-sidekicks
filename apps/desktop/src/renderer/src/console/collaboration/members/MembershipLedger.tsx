import type { MembershipUpdate } from "@ai-sidekicks/contracts";
import { Nothing, formatCount } from "../../primitives/index.js";
import { isLastRemainingOwner, type MembershipRow } from "./members-model.js";
import { type WireMutationSnapshot } from "../mutation-coordinator.js";
import { MembershipLedgerRow } from "./MembershipLedgerRow.js";

export function MembershipLedger(props: {
  readonly rows: readonly MembershipRow[];
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
