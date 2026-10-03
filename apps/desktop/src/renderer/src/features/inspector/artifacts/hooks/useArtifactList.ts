// How a React component holds one artifact list reader.
//
// The reader is stamped to its subject because it holds subject-scoped state (the payload and
// the single-flight fetch are both about one artifact), so a component reused for another
// artifact must not keep the first artifact's bytes or its held control.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { useCallback, useMemo } from "react";

import { useStoreBoundReader } from "@renderer/hooks/subject-scoped/useStoreBoundReader.js";
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
 * The subject is the bridge with the operations, keyed by artifact id. A moved subject mints a
 * new reader, so the component opens on `loading` rather than the previous artifact's bytes.
 * Operations are compared by identity, so a caller must hold them steady.
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
  const { reader, reading } = useStoreBoundReader(
    subject,
    subjectArtifactId,
    sessionStore,
    () => new ArtifactListReader({ ...operations, sessionStore, clock }),
  );
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
