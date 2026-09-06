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
// It is the HOST: the region, its accessible framing, and the four zones in their
// order. It is not the send router, not the chips, not the command surface, and not
// the accessories — each of those is a zone behind its own barrel, filled by its own
// lane, so four lanes edit four directories instead of one file four ways.
//
// It reads no wire itself. All four zones are handed the seat's own props: the
// chip rail and the send bar resolve the address from the session store, and the
// accessory rail reads the session's meters and queue through the bridge. Every
// zone renders the absence of a read rather than a guess at its answer.
//
// THE HOST OWNS THE TWO THINGS TWO ZONES HAVE TO SHARE, and nothing else. The
// command zone's discovery popover opens on a leading slash in the message line —
// a line the send bar owns and this host does not — so it is handed the region and
// OBSERVES the line's own value there rather than being given a copy of it. The
// alternative would be a second source of truth for what a person has typed.
//
// The second is the provider command enumeration. The popover LISTS what the bound
// provider publishes and the send bar has to know whether a typed `/name` is one of
// those entries, and both readings must be one: a second hook in the send bar would
// be a second read of one wire, and a copy kept beside the router would be the
// stored list `Spec-023 §Signature Feature Composition Sketches` §The Session
// Composer forbids. So the host constructs one holder and hands it to both — the
// popover opens it, the send bar only reads it. The host still reads no wire itself;
// it owns the holder the way it owns the region.
//
// THE HOLDER IS A RESOURCE AND IS HELD AS ONE. It owns an open read and a generation
// that supersedes one, so it has a lifetime, and `useMemo` does not give a value one:
// React may discard a memoized value and re-run the factory, which would mint a
// second holder while the first still has a read outstanding — and the discarded one
// would never be told, because nothing ever called `close` on it. `store/`'s resource
// holder is the console's answer to exactly that: `open` runs on the pass that first
// sees a session, `close` runs once however that pass ended, and an unmounting
// composer's outstanding read is superseded rather than left to land in a holder
// nobody holds.

import { useId, useRef } from "react";

import { type ComposerSeatProps } from "../console/seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../console/store/index.js";
import { ComposerAccessoryRail } from "./composer/accessories/index.js";
import { ComposerChipRail } from "./composer/chips/index.js";
import { ProviderCommandAutocomplete } from "./composer/commands/index.js";
import { ProviderCommandEnumeration } from "./composer/commands/provider-command-holder.js";
import { ComposerSendBar } from "./composer/router/index.js";

/** Declared rather than an arrow, so the resource holder is handed a stable pair. */
function openEnumeration(): ProviderCommandEnumeration {
  return new ProviderCommandEnumeration();
}

/**
 * The RELEASING arm, because this holder's `close()` is not terminal.
 *
 * It drops the open key, supersedes whatever read was outstanding, and publishes the
 * unchecked reading — after which `open()` reads again exactly as it did before. So
 * there is no closed state to recognise and none to supply: a `{ dispose, isClosed }`
 * here would claim a lifetime that ends, and the reading beside it would have to be a
 * constant `false`, which is a claim written down twice and true in neither place.
 *
 * At module level so the hook's dependency lists compare stable identities across
 * renders rather than a fresh literal each pass.
 */
const enumerationDisposal: SubjectScopedDisposal<ProviderCommandEnumeration> = {
  release: (enumeration: ProviderCommandEnumeration): void => {
    enumeration.close();
  },
};

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
  const regionRef = useRef<HTMLElement | null>(null);
  // One per addressed composer, and its lifetime is that address's: the enumeration is
  // read live and never persisted, so a holder shared across sessions would be the
  // cache that rule forbids. It deliberately survives a BRIDGE swap under this same
  // session — WHICH binding a reading was taken under is the holder's own key, and
  // that key compares the bridge by identity, so a replaced bridge re-reads rather
  // than being served the previous wire's catalog. That is why the session store is
  // the subject here and the bridge is not.
  const { value: commandEnumeration } = useSubjectScopedResource<ProviderCommandEnumeration>(
    props.sessionStore,
    props.sessionStore.sessionId,
    openEnumeration,
    enumerationDisposal,
  );
  return (
    <section
      className="meridian-composer"
      aria-label="Message composer"
      aria-describedby={descriptionId}
      ref={regionRef}
    >
      <p className="meridian-visually-hidden" id={descriptionId}>
        Composing in session {props.sessionStore.sessionId}.
      </p>
      <ComposerChipRail {...props} />
      <ComposerSendBar {...props} commandEnumeration={commandEnumeration} />
      <ProviderCommandAutocomplete
        {...props}
        region={regionRef}
        commandEnumeration={commandEnumeration}
      />
      <ComposerAccessoryRail {...props} />
    </section>
  );
}
