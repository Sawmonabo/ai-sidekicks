// Content a person arrives at rather than watches change: a view's first read, a stream's replay,
// a list row scrolled back into sight. A line drawn with it is standing, so a screen reader reaches
// it by browsing and the announcer says nothing; a line that appears or changes afterwards
// reports a change and is said.

import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { StandingContentContext, type StandingContentState } from "./context.js";

/** Props for `StandingContent`. */
export interface StandingContentProps {
  readonly children: ReactNode;
  /**
   * True while the content's first read has not answered. Lines drawn until then, and with its
   * answer, are standing. Omitted, the content's own first draw is all that stands.
   */
  readonly isOpening?: boolean;
}

/**
 * Marks what is drawn with this element, and until `isOpening` turns false, as standing. Nested
 * in another, it stands for as long as either does.
 */
export function StandingContent(props: StandingContentProps): React.JSX.Element {
  const outer = useContext(StandingContentContext);
  // A ref, not state: lines read it from their effects, which run before this element's own in the
  // same commit, so the commit that draws the content still finds it opening.
  const isOpeningRef = useRef(true);
  const [standing] = useState<StandingContentState>(() => ({
    isOpening: () => isOpeningRef.current || outer?.isOpening() === true,
  }));
  const isOpening = props.isOpening ?? false;
  useEffect(() => {
    isOpeningRef.current = isOpening;
  }, [isOpening]);
  return (
    <StandingContentContext.Provider value={standing}>
      {props.children}
    </StandingContentContext.Provider>
  );
}
