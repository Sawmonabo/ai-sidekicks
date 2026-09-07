// A channel's record.
//
// The name arm is the interesting one, and it is the reason this kind does not
// share a component with the others: `channel.created` registers `name` as
// OPTIONAL because the implicit channel is unnamed on the wire. So an absent name
// here is not necessarily an unprojected member — it may be the wire saying this
// channel has none. The console cannot tell those apart from the record alone, so
// the absence says exactly that and asserts neither.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function ChannelEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="channel"
      heading="Channel"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="this channel's record may be missing the events that last changed it."
      absentTitle="No channel with this identifier is in the session."
      absentDetail="A channel joins the record when the session materialises it. The implicit channel arrives with the session itself."
      facets={[
        wireFacet("Name", readBodyMember(props.entity, "name"), "name"),
        wireFacet("Attributed to", props.entity?.attributedTo, "attribution"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        A channel with no name is the session&apos;s implicit channel, which the wire leaves
        unnamed. The record cannot tell that apart from a name nobody projected, so it claims
        neither.
      </p>
    </EntityRecord>
  );
}
