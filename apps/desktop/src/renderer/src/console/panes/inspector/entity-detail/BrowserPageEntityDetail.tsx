// A browser page's record — the one kind that is deliberately not durable.
//
// THIS CONSOLE'S OWN RULE, because no committed document states it: a `browser`
// pane sits outside the layout snapshot entirely — it opens beside its source,
// cascades closed with it, and is never written down. So this record
// says so, because an operator who does not know that will expect the page back
// after a restart and find it gone.
//
// The three members are the console's own navigation state: `url`, `title`, and
// `isLoading`. The address is rendered mono and verbatim — it is the one member on
// this record a person may copy, and a shortened URL is a different URL.

import { EntityRecord } from "./EntityRecord.js";
import {
  instantFacet,
  readBodyMember,
  wireFacet,
  type EntityDetailProps,
} from "./entity-facets.js";

export function BrowserPageEntityDetail(props: EntityDetailProps): React.JSX.Element {
  return (
    <EntityRecord
      glyph="browser"
      heading="Browser page"
      entityId={props.entityId}
      state={props.entity?.state}
      isInitialised={props.isInitialised}
      hasRecord={props.entity !== undefined}
      degradedCause={props.degradedCause}
      degradedConsequence="the address below may be a page this one has already navigated away from."
      absentTitle="No browser page with this identifier is open."
      absentDetail="A browser page exists only while its pane does. One that was closed leaves no record behind, which is what makes it ephemeral rather than lost."
      facets={[
        wireFacet("Address", readBodyMember(props.entity, "url"), "address"),
        wireFacet("Title", readBodyMember(props.entity, "title"), "title"),
        instantFacet("Last touched", props.entity?.touchedAt, "touch time"),
      ]}
      linkedSourcePaneId={props.linkedSourcePaneId}
    >
      <p className="meridian-entity-record__note">
        This page is never written to the layout snapshot. It closes with the pane it opened beside,
        and a restart brings back neither.
      </p>
    </EntityRecord>
  );
}
