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
 */
export function useArtifactPaneReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): ArtifactPaneBinding {
  const reader = useMemo(
    () => new ArtifactPaneReader({ bridge, sessionStore }),
    [bridge, sessionStore],
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
