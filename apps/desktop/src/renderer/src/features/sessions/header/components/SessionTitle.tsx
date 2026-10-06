// The session's display title, where it has one. Its own module because it is where the rule is
// obeyed that a nameless session is rendered by its identifier and never by an invented title.

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";

/** The title to draw. */
export interface SessionHeaderSessionTitleProps {
  /** The session's display title, where it has one. */
  readonly title: string | undefined;
}

/**
 * The display title, when the session has one.
 *
 * A session with no title, or one whose title has not arrived, renders nothing: the id beside
 * it is the whole identity, and a badge or skeleton would report a missing answer or shift the id.
 */
export function SessionTitle(props: SessionHeaderSessionTitleProps): React.JSX.Element | null {
  const { title } = props;
  return title === undefined ? null : (
    <span className="meridian-session-header__session-title">
      <WireFigure value={title} />
    </span>
  );
}
