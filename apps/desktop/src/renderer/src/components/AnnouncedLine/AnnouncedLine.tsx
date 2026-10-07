// A line drawn when something happens (an act settled, a check closed a control, a failure). It
// carries no live role and says its words through the app's announcer when they report a change
// (`hooks/announce/useAnnounceWhenChanged.ts` says why); drawn as its view opens, it stands.

import type { ReactNode } from "react";

import type { AnnouncementPoliteness } from "../LiveAnnouncer/announcer.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";

/** Props for `AnnouncedLine`. */
export interface AnnouncedLineProps {
  /** The element the line is drawn as. */
  readonly element: "p" | "span" | "div";
  readonly className?: string;
  /** For a field the line describes (`aria-describedby`). */
  readonly id?: string;
  /** The words the line shows, said when they appear or change after its view first drew. */
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
  useAnnounceWhenChanged(props.words, props.politeness, { attempt: props.attempt });
  const Element = props.element;
  return (
    <Element className={props.className} id={props.id} aria-busy={props.isBusy}>
      {props.children ?? props.words}
    </Element>
  );
}
