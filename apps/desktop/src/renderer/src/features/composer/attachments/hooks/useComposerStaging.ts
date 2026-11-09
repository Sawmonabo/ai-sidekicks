// The composer's file staging: files dropped or pasted over the composer upload to the daemon, and
// each one the daemon has copied leaves the staged list for the held draft, which names it on the
// next send and saves it with the words, so another device sees it.

import { useEffect, useMemo } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import type { AttachmentIngestPort } from "../services/ingest-port.js";
import { useAttachmentDropTarget } from "./useAttachmentDropTarget.js";
import { useStagedAttachments, type StagedAttachmentsBinding } from "./useStagedAttachments.js";

/** The staged uploads the strip draws, and whether a file drag is over the composer. */
export interface ComposerStaging {
  readonly stagedAttachments: StagedAttachmentsBinding;
  readonly isDraggingFiles: boolean;
}

/** Stage files dropped or pasted over `region` for `sessionId`, handing each copied file on. */
export function useComposerStaging(
  bridge: PlatformBridge,
  sessionId: SessionId,
  region: React.RefObject<HTMLElement | null>,
  heldDraft: ComposerHeldDraft,
): ComposerStaging {
  const port = useMemo(() => ingestPortOver(bridge), [bridge]);
  const stagedAttachments = useStagedAttachments(bridge, sessionId, port);
  const isDraggingFiles = useAttachmentDropTarget({
    region,
    onFilesChosen: stagedAttachments.attachFiles,
  });
  const { entries } = stagedAttachments.snapshot;
  const { remove } = stagedAttachments;
  useEffect(() => {
    for (const entry of entries) {
      if (entry.state === "complete" && entry.derived !== undefined) {
        heldDraft.addStagedFile(entry.derived);
        remove(entry.declared.localId);
      }
    }
  }, [entries, heldDraft, remove]);
  return { stagedAttachments, isDraggingFiles };
}

/** The three ingest calls over the daemon; a refused call rejects with the daemon's refusal. */
function ingestPortOver(bridge: PlatformBridge): AttachmentIngestPort {
  return {
    begin: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "artifact.ingest.start", request)),
    writeChunk: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "artifact.ingest.write", request)),
    complete: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "artifact.ingest.complete", request)),
  };
}
