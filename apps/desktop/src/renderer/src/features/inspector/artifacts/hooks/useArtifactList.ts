// How a React component holds one artifact list reader: construction, subscription and disposal.
//
// The reader is stamped to its subject because it holds subject-scoped state (the payload and
// the single-flight fetch are both about one artifact), so a component reused for another
// artifact must not keep the first artifact's bytes or its held control.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { ArtifactListReading, ArtifactRowActOutcome } from "../artifact-list-reading.js";
import type { ArtifactOperations } from "../services/artifact-reads.js";
import type { ArtifactPayloadOutcome } from "@renderer/store/artifacts/artifact-payload.js";
import { ArtifactListReader } from "../artifact-list-reader.js";

/** What the hook hands its component: the reading, and the acts it can put to the port. */
export interface ArtifactListBinding {
  readonly reading: ArtifactListReading;
  readonly refresh: () => void;
  readonly readManifest: (artifactId: ArtifactId) => Promise<ArtifactRowActOutcome>;
  readonly fetchPayload: (artifactId: ArtifactId) => Promise<ArtifactPayloadOutcome>;
}

/**
 * Bind one component to its reader.
 *
 * The subject is the bridge with the operations, keyed by artifact id, held through
 * `useSubjectScopedResource`, which closes the reader however its render ended (including a
 * discarded pass). A moved subject mints a new reader, so the component opens on `loading`
 * rather than the previous artifact's bytes. Operations are compared by identity, so a
 * caller must hold them steady. The store is not part of the seam's key: a projection
 * replaced across a reconnect is caught by asking the reader and published through the seam.
 */
export function useArtifactList(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  subjectArtifactId: string,
  operations: ArtifactOperations,
): ArtifactListBinding {
  const clock = useBridgeClock();
  // The reader reads the session's whole list, so the artifact id is not passed to it: the
  // key only decides whose subject-scoped state this reader holds.
  const subject = useMemo(() => ({ bridge, operations }), [bridge, operations]);
  const { value: reader, settle } = useSubjectScopedResource(
    subject,
    subjectArtifactId,
    () => new ArtifactListReader({ ...operations, sessionStore, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // The store axis only; disposal is the seam's.
    if (!reader.isReadingFor(sessionStore)) {
      settle()(new ArtifactListReader({ ...operations, sessionStore, clock }));
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
    (artifactId: ArtifactId) => reader.readManifest(artifactId),
    [reader],
  );
  const fetchPayload = useCallback(
    (artifactId: ArtifactId) => reader.fetchPayload(artifactId),
    [reader],
  );
  return { reading, refresh, readManifest, fetchPayload };
}
