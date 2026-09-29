// The display title a session carries, where it carries one.
//
// Its own module for the one-component rule, and it earns one: a nameless session is
// rendered by its identifier and never by an invented title, and this is where that
// rule is obeyed rather than a fragment of the header's arrangement.
//
// WHY THE TITLE IS LABELLED AS METADATA. No registered session shape carries a
// first-class name field — `SessionSnapshot` is `id`, `state`, `config`, `metadata`,
// and two timestamps, and `session.created`'s payload is `.strict()` with no title
// member at all. A display title is therefore metadata a session happens to carry,
// and saying so on the element is the difference between rendering a fact and
// asserting a field that does not exist.

import { WireFigure } from "@renderer/console/primitives/index.js";

export interface SessionHeaderSessionTitleProps {
  /** The session's display title, where it has one. */
  readonly title: string | undefined;
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
 * A title that has not arrived renders nothing for the same reason: the id is the
 * whole identity until it does, and a skeleton bar beside the id would move it when the
 * title resolved.
 */
export function SessionHeaderSessionTitle(
  props: SessionHeaderSessionTitleProps,
): React.JSX.Element | null {
  const { title } = props;
  return title === undefined ? null : (
    // Labelled as metadata on the element itself, because that is what it IS: no
    // registered session shape has a name field, and a reader who wonders where the
    // name came from gets the honest answer from the title attribute.
    <span className="meridian-session-header__session-title" title="Session metadata title">
      <WireFigure value={title} />
    </span>
  );
}
