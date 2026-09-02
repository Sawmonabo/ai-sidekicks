// The composer: the shell chrome every session view contains, and the seat's body.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer calls it
// "the shell chrome every session view already contains" — one input, one primary
// action, and the two chips that say where a message is going and under what
// posture. The workspace mounts whatever fills the composer seat; this file is what
// fills it.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// It is the HOST: the region, its accessible framing, and the three zones in their
// order. It is not the send router, not the chips, and not the accessories — each
// of those is a zone behind its own barrel, filled by its own lane, so three lanes
// edit three directories instead of one file three ways.
//
// It reads no wire itself. The two zones that address a message — the chip rail and
// the send bar — are handed the seat's own props and resolve the address from the
// session store; the accessory rail takes none yet, because nothing in it is
// addressed. Every zone renders the absence of a read rather than a guess at its
// answer.

import { useId } from "react";

import { type ComposerSeatProps } from "../console/workspace/index.js";
import { ComposerAccessoryRail } from "./composer/accessories/index.js";
import { ComposerChipRail } from "./composer/chips/index.js";
import { ComposerSendBar } from "./composer/router/index.js";

/**
 * The composer, addressed within one session.
 *
 * The session is named in a visually-hidden description rather than in the label.
 * A person can hold two windows on two sessions at once — the console ships two
 * auxiliary windows precisely so they can — and "Message composer" alone would
 * announce identically in both. The label stays short for the sighted reader who
 * has the window's own chrome to tell them apart.
 */
export function MessageComposer(props: ComposerSeatProps): React.JSX.Element {
  const descriptionId = useId();
  return (
    <section
      className="meridian-composer"
      aria-label="Message composer"
      aria-describedby={descriptionId}
    >
      <p className="meridian-visually-hidden" id={descriptionId}>
        Composing in session {props.sessionStore.sessionId}.
      </p>
      <ComposerChipRail {...props} />
      <ComposerSendBar {...props} />
      <ComposerAccessoryRail />
    </section>
  );
}
