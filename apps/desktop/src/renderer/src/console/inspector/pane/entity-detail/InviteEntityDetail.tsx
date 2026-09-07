// An invite's record — a membership that has not happened yet.
//
// The invite card is the collaboration family's, and this is the record its card
// opens: the address union admits an invite reference for the inspector, so this
// table answers for the kind whether or not that family has landed.
//
// IT CARRIES NO WIRE FACET, and that is a reading of the corpus rather than an
// omission. The four `invite.*` types are in the census and none of them registers a
// payload variant, so there is no member this record could quote verbatim — and a
// facet naming `inviteeHandle` or `expiresAt` would be this console teaching a
// surface to read a member no daemon sets. The identifier and the projected state
// are what the record has, and they are what it shows.

import { EntityRecord } from "./EntityRecord.js";
import { instantFacet, type EntityDetailProps } from "./entity-facets.js";

export function InviteEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="member"
      heading="Invite"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="an invite that has since been accepted, revoked, or expired could still read as pending."
      absentTitle="No invite with this identifier is in the session."
      absentDetail="An invite joins the record when the session sends one. Send one from the members section and it appears here until it is accepted, revoked, or expires."
      facets={[instantFacet("Last touched", props.entity?.touchedAt, "touch time")]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        Who was invited, how, and until when are on no registered member of any
        <code> invite.*</code> payload, so this record shows none. The members section&apos;s own
        read is where those reach a person.
      </p>
    </EntityRecord>
  );
}
