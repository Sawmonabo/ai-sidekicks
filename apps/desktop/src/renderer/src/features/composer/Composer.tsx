// The composer: the chrome every session view contains.
//
// The session screen mounts whatever the composer registry holds; this file is what it holds.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// It is the HOST: the region, its accessible framing, and the zones it mounts in their
// order. It is not the send router, not the chips, not the command list, and not the
// accessories — each of those is a zone of its own, so separate lanes edit separate
// directories instead of one file several ways.
//
// It reads no wire itself. The zones are handed the composer's own props: the accessory
// rail reads the session's context meter off the session store and carries attachments
// through the bridge, and every zone renders the absence of a read rather than a
// guess at its answer.
//
// THE MESSAGE LINE IS MOUNTED AND SEND IS NOT. The line reads and writes the addressed
// draft and needs no call, so the host draws it. `SendButton` takes the two daemon
// calls a send makes as an argument and the composer's props carry none, so this host
// draws no Send control: Enter keeps the draft as typed and sends nothing.
//
// THE HOST OWNS WHAT ZONES HAVE TO SHARE, and nothing else. The command zone's
// discovery popover opens on a leading slash in the addressed draft and is handed the
// region, so it OBSERVES the draft store's own value there rather than being given a
// copy of it.
//
// The provider command enumeration is the host's too: the popover LISTS what the bound
// provider publishes, and the enumeration is read live and never cached, so the host
// constructs one holder and hands it to the popover, which opens it. The host still
// reads no wire itself; it owns the holder the way it owns the region.
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

import { type ComposerProps } from "@renderer/console/seats/index.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { ComposerToolbar } from "./components/ComposerToolbar.js";
import { CommandList } from "./command-list/components/CommandList.js";
import { ProviderCommandEnumeration } from "./command-list/provider-command-enumeration.js";
import { DraftLine } from "./draft-line/components/DraftLine.js";
import "./Composer.css";

/** Declared rather than an arrow, so the resource holder is handed a stable pair. */
function openEnumeration(): ProviderCommandEnumeration {
  return new ProviderCommandEnumeration();
}

/**
 * The RELEASING arm, because this holder's `close()` is not terminal.
 *
 * It drops the open key, supersedes whatever read was outstanding, and publishes the
 * unchecked reading — after which `open()` reads again exactly as it did before. So
 * there is no closed state to recognize and none to supply: a `{ dispose, isClosed }`
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
export function MessageComposer(props: ComposerProps): React.JSX.Element {
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
      <DraftLine {...props} />
      <CommandList {...props} region={regionRef} commandEnumeration={commandEnumeration} />
      <ComposerToolbar {...props} />
    </section>
  );
}
