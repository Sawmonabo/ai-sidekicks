// Binds one set of staged attachments to one component's lifetime.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { AttachmentIngestPort } from "../services/attachment-ingest-answer.js";
import { StagedAttachments, type StagedAttachmentsSnapshot } from "../staged-attachments.js";

/** What a view holding a staged list renders and acts through. */
export interface StagedAttachmentsBinding {
  readonly snapshot: StagedAttachmentsSnapshot;
  readonly attachFiles: (files: readonly File[]) => void;
  readonly retry: (localId: string) => void;
  readonly abandon: (localId: string) => void;
}

/**
 * Bind one staged list to one component's lifetime, keyed by the bridge and the session. The
 * seam re-mints a list that a StrictMode double-mount disposed; otherwise later files would
 * reach a disposed ingest client and the strip would go inert with nothing on screen to say so.
 * The `port` is read when the list opens, so a different port does not re-open it.
 */
export function useStagedAttachments(
  bridge: PlatformBridge,
  sessionId: SessionId,
  port: AttachmentIngestPort,
): StagedAttachmentsBinding {
  const clock = useBridgeClock();
  const { value: stagedAttachments } = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new StagedAttachments({ port, sessionId, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    stagedAttachments.start();
  }, [stagedAttachments]);
  const subscribe = useCallback(
    (onStagedAttachmentsChange: () => void) =>
      stagedAttachments.subscribe(onStagedAttachmentsChange),
    [stagedAttachments],
  );
  const read = useCallback(() => stagedAttachments.snapshot, [stagedAttachments]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const attachFiles = useCallback(
    (files: readonly File[]) => {
      stagedAttachments.attachFiles(files);
    },
    [stagedAttachments],
  );
  const retry = useCallback(
    (localId: string) => {
      stagedAttachments.retry(localId);
    },
    [stagedAttachments],
  );
  const abandon = useCallback(
    (localId: string) => {
      stagedAttachments.abandon(localId);
    },
    [stagedAttachments],
  );
  return { snapshot, attachFiles, retry, abandon };
}
