// How a React surface holds one artifact pane's reader, and nothing about what the
// reader reads.
//
// Split from `artifact-reader.ts` on the seam `repos/proposal-gate-binding.ts` already
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

import type { ConsoleBridge } from "../../bridge/index.js";
import type { SessionStore } from "../../store/index.js";
import type {
  ArtifactDeleteOutcome,
  ArtifactPaneReading,
  ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";
import { ArtifactPaneReader } from "./artifact-reader.js";

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
 * THE SUBJECT IS PART OF THE READER'S IDENTITY, which is `repos/proposal-gate-binding.ts`'s
 * stamp-to-subject shape: that hook keys its memo on the subject's PARTS, and this
 * one's subject is a single id, so the id is the whole of it. A subject that moved
 * mints a new reader and the effect below disposes the old one — so the pane opens on
 * the new artifact's not-read absence rather than on the previous artifact's bytes,
 * and a fetch still on the wire for the previous subject settles into a disposed
 * reader instead of holding this one's control.
 *
 * The id and not the address object: the deck composes a pane context on every
 * render, so a memo keyed on it would mint a reader — and a read pair — every time
 * the deck re-rendered.
 */
export function useArtifactPaneReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
  subjectArtifactId: string,
): ArtifactPaneBinding {
  const reader = useMemo(
    () => new ArtifactPaneReader({ bridge, sessionStore }),
    // The subject is a dependency the constructor is not handed: the reader reads the
    // session's whole list rather than one artifact, so nothing inside it takes an
    // artifact id — what the subject decides is which reader's subject-scoped state
    // this is, which is exactly what a memo key decides.
    [bridge, sessionStore, subjectArtifactId],
  );
  useEffect(() => {
    reader.start();
    return () => {
      reader.dispose();
    };
  }, [reader]);
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
