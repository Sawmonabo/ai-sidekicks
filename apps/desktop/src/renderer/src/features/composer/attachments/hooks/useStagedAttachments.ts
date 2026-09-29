// Binds one set of staged attachments to one component's lifetime.

import type { SessionId } from "@ai-sidekicks/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
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
 * Bind one staged list to one component's lifetime.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION, which is what a staged list is
 * scoped to, so the console's own resource seam holds it: `useSubjectScopedResource`
 * opens the staged list on the render that first sees a `(bridge, session)` pair and
 * closes it however that render ended, including a pass React discards. It is also
 * what keeps this module off a second implementation of subject-scoped state.
 *
 * The `port` is read when the staged list opens, so it must stay the same for the life of
 * a `(bridge, session)` pair; a different port does not re-open the staged list.
 *
 * THE SEAM RE-MINTS A CLOSED STAGED LIST. React's StrictMode double-mount runs the seam's
 * cleanup and then this effect's setup again on the SAME committed staged list, and the
 * cleanup terminally disposes the ingest client. Left in place, every file the user
 * chose afterwards would reach a client whose `attach` returns at once: the attachment
 * strip inert, with nothing on screen to say so. The seam's `isClosed`, supplied
 * beside `close`, replaces it, so this effect starts a staged list and does nothing else.
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
