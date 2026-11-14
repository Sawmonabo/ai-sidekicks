// The composer's file staging: files dropped or pasted over the composer, or picked with Attach,
// reach the daemon as main's tokens for their paths, and the daemon copies and holds them with the
// session. A dropped file's token is main's; a pasted picture is written to a file first. A
// dropped folder is never offered, since an agent reads a folder where it is.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { FilePathRef } from "#shared/preload-api.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import {
  ComposerStaging,
  NOTHING_STAGING,
  type ComposerStagingSnapshot,
  type OfferedFile,
  type StagingCalls,
  type UnofferedFile,
} from "../staging.js";
import {
  useAttachmentDropTarget,
  type ChosenFile,
  type FileSource,
} from "./useAttachmentDropTarget.js";

/** What the strip draws and the acts it offers, and whether a file drag is over the composer. */
export interface ComposerStagingBinding {
  readonly staging: ComposerStaging;
  readonly snapshot: ComposerStagingSnapshot;
  readonly isDraggingFiles: boolean;
  /** Open the system's file picker and stage what the person picks. */
  readonly pickFiles: () => void;
}

/**
 * Stage files offered over `region`, or picked, for `sessionId`, into `heldDraft`; `undefined`
 * for a session id the wire does not admit, which nothing can be staged for.
 */
export function useComposerStaging(
  bridge: PlatformBridge,
  sessionId: SessionId | undefined,
  region: React.RefObject<HTMLElement | null>,
  heldDraft: ComposerHeldDraft,
): ComposerStagingBinding | undefined {
  const staging = useMemo(
    () =>
      sessionId === undefined
        ? undefined
        : new ComposerStaging(stagingCallsOver(bridge, sessionId), heldDraft, newStagingId),
    [bridge, sessionId, heldDraft],
  );
  const snapshot = useSyncExternalStore(
    staging?.subscribe ?? subscribeToNothing,
    staging?.snapshot ?? readNothingStaging,
  );
  const onFilesChosen = useCallback(
    (chosen: readonly ChosenFile[], source: FileSource) => {
      if (staging === undefined) {
        return;
      }
      const folders = chosen.filter((each) => each.isFolder);
      const files = chosen.filter((each) => !each.isFolder);
      void Promise.allSettled(files.map((each) => tokenFor(bridge, each.file, source))).then(
        (tokens) => {
          const offered: OfferedFile[] = [];
          const unoffered: UnofferedFile[] = folders.map((each) => ({
            name: each.file.name,
            cause: { kind: "folder" },
          }));
          tokens.forEach((token, index) => {
            const file = files[index]?.file;
            if (file === undefined) {
              return;
            }
            if (token.status === "fulfilled") {
              offered.push({ ref: token.value, name: file.name, sizeBytes: file.size });
            } else {
              // Main's own words for why it would not mint the token.
              unoffered.push({
                name: file.name,
                cause: {
                  kind: "ownWords",
                  words: coerceToRefusal(token.reason, STAGING_ORIGIN, FILE_NOT_OFFERED).detail,
                },
              });
            }
          });
          staging.stage(offered, unoffered);
        },
      );
    },
    [bridge, staging],
  );
  const isDraggingFiles = useAttachmentDropTarget({ region, onFilesChosen });
  const pickFiles = useCallback(() => {
    if (staging === undefined) {
      return;
    }
    void bridge.native.showOpenDialog({ purpose: "attachFiles" }).then(
      (picked) => {
        staging.stage(picked.refs);
      },
      (rejection: unknown) => {
        staging.refusePick(coerceToRefusal(rejection, STAGING_ORIGIN, FILES_NOT_PICKED));
      },
    );
  }, [bridge, staging]);
  return staging === undefined ? undefined : { staging, snapshot, isDraggingFiles, pickFiles };
}

/** Names the composer's staging in a refusal. */
const STAGING_ORIGIN = "composer-staging";

/** The code for a file main would not mint a token for. */
const FILE_NOT_OFFERED = "file-not-offered";

/** The code for a file picker that could not open or answer. */
const FILES_NOT_PICKED = "files-not-picked";

/** Main's token for one offered file: a dropped file's own, or a pasted picture written out. */
async function tokenFor(
  bridge: PlatformBridge,
  file: File,
  source: FileSource,
): Promise<FilePathRef> {
  return source === "paste" && file.type.startsWith("image/")
    ? await bridge.native.savePastedImage(await file.arrayBuffer())
    : await bridge.native.getDroppedFileRef(file);
}

/** The two staging calls over the daemon for one session. */
function stagingCallsOver(bridge: PlatformBridge, sessionId: SessionId): StagingCalls {
  return {
    add: async ([first, ...rest]) =>
      await callDaemon(bridge, "session.attachment.add", {
        sessionId,
        items: [
          { kind: "file", ...first },
          ...rest.map((item) => ({ kind: "file" as const, ...item })),
        ],
      }),
    remove: async (artifactId) =>
      await callDaemon(bridge, "session.attachment.remove", { sessionId, artifactId }),
  };
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function readNothingStaging(): ComposerStagingSnapshot {
  return NOTHING_STAGING;
}

function newStagingId(): string {
  return crypto.randomUUID();
}
