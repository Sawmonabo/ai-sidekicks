// The display title a session read carried, where it carried one.
//
// Its own module for the one-component rule, and it earns one: what a nameless
// session renders is a decision `Spec-023 §Console Design (Meridian)` states — "by
// its identifier and participants, never by an invented title" — and this is where
// that sentence is obeyed rather than a fragment of the header's arrangement.
//
// WHY THE TITLE IS LABELLED AS METADATA. No registered session shape carries a
// first-class name field — `SessionSnapshot` is `id`, `state`, `config`, `metadata`,
// and two timestamps, and `session.created`'s payload is `.strict()` with no title
// member at all. A display title is therefore metadata a session happens to carry,
// and saying so on the element is the difference between rendering a fact and
// asserting a field that does not exist.

import { type GrowthSessionSummary } from "../../bridge/index.js";
import { WireFigure } from "../../primitives/index.js";
import { type CastBarReadState } from "./cast-bar-reads.js";

export interface CastBarSessionTitleProps {
  readonly identity: CastBarReadState<GrowthSessionSummary>;
}

/**
 * The display title, when the session has one.
 *
 * A session with NO title renders nothing here — not an absence, not a placeholder.
 * The rule this follows is the same one the all-sessions list follows: an untitled
 * session is named by its identifier, which is already on screen a few pixels to the
 * left, and a "not checked" badge beside it would report a missing answer where the
 * answer is that this session has no name.
 *
 * A read that has not settled renders nothing for the same reason: the id is the
 * whole identity until the title arrives, and a skeleton bar between the id and the
 * state chip would move both of them when it resolved.
 */
export function CastBarSessionTitle(props: CastBarSessionTitleProps): React.JSX.Element | null {
  const title = props.identity.status === "served" ? props.identity.value.title : undefined;
  return title === undefined ? null : (
    // Labelled as metadata on the element itself, because that is what it IS: no
    // registered session shape has a name field, and a reader who wonders where the
    // name came from gets the honest answer from the title attribute.
    <span className="meridian-cast-bar__session-title" title="Session metadata title">
      <WireFigure value={title} />
    </span>
  );
}
