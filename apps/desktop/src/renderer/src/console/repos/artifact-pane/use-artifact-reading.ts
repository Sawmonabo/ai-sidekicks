// How a React surface holds one artifact pane's reader, and nothing about what the
// reader reads.
//
// Split from `artifact-reader.ts` on the seam `repos/proposals/proposal-gate-binding.ts` already
// cuts: the class beside this one owns the READ — which calls, on which of the four
// reasons, and what it publishes when one does not answer — and this module owns the
// BINDING, which is a different subject with a different collaborator (React's
// rendering lifecycle rather than the bridge) and its own teardown. They meet at one
// object, the reader, which is the whole seam.
//
// The reader is constructed in a hook and never in a render body, subscribed through
// `useSyncExternalStore` so a publish is a single transition, and disposed on unmount
// — the three properties `apps/desktop/AGENTS.md` requires of anything holding state
// beside a component.
//
// AND IT IS STAMPED TO ITS SUBJECT, which is the fourth property and the one this
// binding was missing. A reader holds SUBJECT-SCOPED state — the payload arm and the
// single-flight fetch register are both about one artifact — while the memo below
// keyed only on the bridge and the session store, so a deck that reused this pane for
// another artifact in the same session kept the same reader. Artifact A's fetched
// bytes went on rendering under B's header (neither the text nor the opaque arm draws
// an artifact id, so there was nothing on screen to contradict it), and an A fetch
// still on the wire held B's control disabled.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedResource, type SessionStore } from "../../store/index.js";
import type {
  ArtifactDeleteOutcome,
  ArtifactPaneReading,
  ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

/** Close one reader. Declared once so the resource seam holds one identity for it. */
function closeArtifactPaneReader(reader: ArtifactPaneReader): void {
  reader.dispose();
}

/** What the hook hands the pane: the reading, and the acts it can put to the port. */
export interface ArtifactPaneBinding {
  readonly reading: ArtifactPaneReading;
  readonly refresh: () => void;
  readonly readManifest: (artifactId: string) => Promise<ArtifactRowActOutcome>;
  readonly fetchPayload: (artifactId: string) => Promise<ArtifactPayloadOutcome>;
  readonly deleteArtifact: (artifactId: string) => Promise<ArtifactDeleteOutcome>;
}

/**
 * Bind one pane to its reader.
 *
 * Constructed in a hook and never in a render body, read through
 * `useSyncExternalStore` so a publish is one transition, and disposed on unmount.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE ARTIFACT, held through the console's
 * own resource seam. `useSubjectScopedResource` opens the reader on the render that
 * first sees a `(bridge, artifact)` pair and closes it however that render ended —
 * including the pass React discards, which the `useMemo` this replaces never closed at
 * all. React documents a memo as a cache it MAY discard, and a discard with unchanged
 * dependencies constructed a second reader mid-render: `useSyncExternalStore` then
 * read that reader's not-read-yet absence, the effect disposed the committed one, and
 * the pane blanked and re-ran a whole read pair for no participant action.
 *
 * THE ARTIFACT ID IS THE WHOLE KEY, and it is not a narrowing of the memo it replaces.
 * An artifact id names one artifact of one session, so a key that moved to another
 * session moved this key too; what one bridge holds many of is artifacts, which is
 * exactly what a key inside a subject's key space is for. A subject that moved mints a
 * new reader — so the pane opens on the new artifact's not-read absence rather than on
 * the previous artifact's bytes, and a fetch still on the wire for the previous subject
 * settles into a disposed reader instead of holding this one's control.
 *
 * The id and not the address object: the deck composes a pane context on every
 * render, so a subject keyed on it would mint a reader — and a read pair — every time
 * the deck re-rendered.
 *
 * A RE-MINT ARM, on `useAttachmentCarrier`'s shape and for both of its reasons. The
 * seam's disposal followed by a replayed setup on the same committed reader is what
 * React's development double-mount does, and a disposed reader's `start()` returns at
 * once — the pane inert with nothing on screen to say so. The store is the second
 * reason: it is not part of the seam's key, so a projection replaced across a
 * reconnect is caught by asking the reader rather than by keying on it. The
 * replacement is PUBLISHED through the seam, so it is closed on the seam's own terms
 * rather than by a cleanup of this effect's.
 */
export function useArtifactPaneReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
  subjectArtifactId: string,
): ArtifactPaneBinding {
  // The window's own clock, resolved once per bridge — `clone-expiry-wake-up.ts`'s
  // shape. `consoleClockFor` is the one answer to which clock a window runs on, and
  // the reader used to default to a `RealClock` of its own, so a pane under the
  // fixture scheduled its reads on wall time while the scenario advanced on frozen
  // time.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  // The subject is a key the constructor is not handed: the reader reads the session's
  // whole list rather than one artifact, so nothing inside it takes an artifact id —
  // what the key decides is whose subject-scoped state this reader holds.
  const { value: reader, settle } = useSubjectScopedResource(
    bridge,
    subjectArtifactId,
    () => new ArtifactPaneReader({ bridge, sessionStore, clock }),
    closeArtifactPaneReader,
  );
  useEffect(() => {
    if (!reader.isCurrentFor(sessionStore)) {
      settle()(new ArtifactPaneReader({ bridge, sessionStore, clock }));
      return;
    }
    reader.start();
  }, [reader, settle, bridge, sessionStore, clock]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback(() => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
  const refresh = useCallback(() => {
    reader.refresh();
  }, [reader]);
  const readManifest = useCallback(
    (artifactId: string) => reader.readManifest(artifactId),
    [reader],
  );
  const fetchPayload = useCallback(
    (artifactId: string) => reader.fetchPayload(artifactId),
    [reader],
  );
  const deleteArtifact = useCallback(
    (artifactId: string) => reader.deleteArtifact(artifactId),
    [reader],
  );
  return { reading, refresh, readManifest, fetchPayload, deleteArtifact };
}
