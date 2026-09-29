// How a React surface holds one artifact pane's reader, and nothing about what the reader
// reads.
//
// Split from `artifact-list-reader.ts`: that class owns the read, and this module owns the
// binding to React's rendering lifecycle and its teardown. They meet at one object.
//
// The reader is constructed in a hook and never in a render body, subscribed through
// `useSyncExternalStore` so a publish is a single transition, and disposed on unmount. It
// is also stamped to its subject: a reader holds subject-scoped state (the payload and
// the single-flight fetch are both about one artifact), so a surface reused for another
// artifact must not keep the first artifact's bytes or its held control.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { consoleClockFor } from "@renderer/services/platform/hooks/useClock.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { ArtifactListReading, ArtifactRowActOutcome } from "../artifact-list-reading.js";
import type { ArtifactOperations } from "../services/artifact-reads.js";
import type { ArtifactPayloadOutcome } from "@renderer/store/artifacts/artifact-payload.js";
import { ArtifactPaneReader } from "../artifact-list-reader.js";

/** What the hook hands its surface: the reading, and the acts it can put to the port. */
export interface ArtifactListBinding {
  readonly reading: ArtifactListReading;
  readonly refresh: () => void;
  readonly readManifest: (artifactId: string) => Promise<ArtifactRowActOutcome>;
  readonly fetchPayload: (artifactId: string) => Promise<ArtifactPayloadOutcome>;
}

/**
 * Bind one surface to its reader.
 *
 * The subject is the bridge together with the operations, and the key is the artifact id,
 * held through the console's resource seam. `useSubjectScopedResource` opens the reader
 * on the render that first sees a `(bridge, operations, artifact)` triple and closes it
 * however that render ended, including a pass React discards. A moved subject mints a new
 * reader, so the surface opens on the new artifact's `loading` reading rather than the
 * previous artifact's bytes, and a fetch still on the wire for the previous subject
 * settles into a disposed reader. The operations are compared by identity, so a caller
 * that builds them anew on every render would mint a reader on every render and has to
 * hold them steady. The artifact id and not an address object is the key, because a caller
 * may compose its address object on every render.
 *
 * The seam's disposal followed by a replayed setup on the same committed reader is what
 * React's development double-mount does, and a disposed reader's `start()` returns at
 * once. The seam handles that through `isClosed`. The store is the half that stays here:
 * it is not part of the seam's key, so a projection replaced across a reconnect is caught
 * by asking the reader, and the replacement is published through the seam so it is closed
 * on the seam's own terms.
 */
export function useArtifactList(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  subjectArtifactId: string,
  operations: ArtifactOperations,
): ArtifactListBinding {
  // The window's own clock, resolved once per bridge.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  // The reader reads the session's whole list, so the artifact id is not passed to it: the
  // key only decides whose subject-scoped state this reader holds.
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { value: reader, settle } = useSubjectScopedResource(
    subject,
    subjectArtifactId,
    () => new ArtifactPaneReader({ ...operations, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // The store axis only; disposal is the seam's.
    if (!reader.isReadingFor(sessionStore)) {
      settle()(new ArtifactPaneReader({ ...operations, sessionStore, clock }));
      return;
    }
    reader.start();
  }, [reader, settle, operations, sessionStore, clock]);
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
  return { reading, refresh, readManifest, fetchPayload };
}
