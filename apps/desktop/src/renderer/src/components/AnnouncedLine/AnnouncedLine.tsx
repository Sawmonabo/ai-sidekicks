// A line drawn when something happens (an act settled, a check closed a control, a failure), which
// mounts already holding its words. Most screen readers never announce a live region inserted with
// its text, so the line carries no live role and says its words once through the app's announcer.

import type { ReactNode } from "react";

import type { AnnouncementPoliteness } from "../LiveAnnouncer/announcer.js";
import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";

/** Props for `AnnouncedLine`. */
export interface AnnouncedLineProps {
  /** The element the line is drawn as. */
  readonly element: "p" | "span" | "div";
  readonly className?: string;
  /** For a field the line describes (`aria-describedby`). */
  readonly id?: string;
  /** The words the line shows, said when it is drawn and again when they change. */
  readonly words: string;
  /** `assertive` for a refusal or a failure, `polite` for everything else. */
  readonly politeness: AnnouncementPoliteness;
  /**
   * What the line draws where it is more than its words, such as a control beside them, which is
   * not read out. Defaults to the words.
   */
  readonly children?: ReactNode;
  /** Marks a line standing in for content that is being replaced. */
  readonly isBusy?: boolean;
  /**
   * The attempt this line answers, for a retry that can end in the same words: a new value says
   * them again. Keep its identity across renders (the refusal the retry replaces).
   */
  readonly attempt?: unknown;
}

/** A drawn line that speaks its words through the app's announcer. */
export function AnnouncedLine(props: AnnouncedLineProps): React.JSX.Element {
  useAnnounceWhenShown(props.words, props.politeness, props.attempt);
  const Element = props.element;
  return (
    <Element className={props.className} id={props.id} aria-busy={props.isBusy}>
      {props.children ?? props.words}
    </Element>
  );
}
