import type { ServedInvite } from "../../bridge/index.js";
import { Nothing, PartialRead } from "../../primitives/index.js";
import { SHELF_SUBJECT, type ShelfReading } from "./invite-shelf-reading.js";
import { InviteRow } from "./InviteRow.js";

export function ShelfBody(props: {
  readonly reading: ShelfReading | undefined;
  readonly visible: readonly ServedInvite[];
  readonly onSetAside: (inviteId: string) => void;
}): React.JSX.Element {
  const { reading } = props;
  if (reading === undefined) {
    return <Nothing kind="not-loaded" placement="surface" title="Reading your invitations." />;
  }
  if (reading.askedCount === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No invitations have been read."
        detail="The invites read is scoped to a session, and this console is holding none — so it has not asked. This is not an empty inbox."
      />
    );
  }
  // The notice comes FIRST and the rows follow it, which is the console's own rule
  // for a reading that is not the whole of it: what a notice withdraws is the claim
  // that the rows are all of it, so it can never be read as a footnote to them.
  //
  // A refusal that is the WHOLE answer takes the rows away with it — nothing
  // answered, so there is nothing an empty state could honestly say. Anything else
  // renders under whatever the sessions that DID answer produced, an empty shelf
  // included, since "one session has nothing for you and another would not say" is
  // two facts and the shelf owes a person both of them.
  return (
    <>
      <PartialRead states={reading.states} subject={SHELF_SUBJECT} />
      {reading.servedCount === 0 ? null : props.visible.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="Nothing is waiting for you to join."
          detail="An invitation appears here while it is pending, with the date it stops working."
        />
      ) : (
        <ul className="meridian-invite-shelf__rows">
          {props.visible.map((invite) => (
            <li key={invite.inviteId}>
              <InviteRow
                invite={invite}
                actionLabel="Not now"
                onAct={() => {
                  props.onSetAside(invite.inviteId);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
