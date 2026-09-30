// The session's name, where it has one.
//
// Its own module for the one-component rule, and it earns one: a nameless session is
// rendered by its identifier and never by an invented title, and this is where that
// rule is obeyed rather than a fragment of the header's arrangement.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";

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
export function SessionTitle(props: SessionHeaderSessionTitleProps): React.JSX.Element | null {
  const { title } = props;
  return title === undefined ? null : (
    <span className="meridian-session-header__session-title">
      <WireFigure value={title} />
    </span>
  );
}
