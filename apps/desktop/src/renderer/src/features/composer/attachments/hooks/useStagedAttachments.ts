// Binds one set of staged attachments to one component's lifetime.

import type { SessionId } from "@ai-sidekicks/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/console/store/act/use-act-controller.js";
import { useSubjectScopedResource } from "@renderer/console/store/subject-scoped/subject-scoped-resource.js";
import type { AttachmentIngestPort } from "../services/attachment-ingest-answer.js";
import { StagedAttachments, type StagedAttachmentsSnapshot } from "../staged-attachments.js";

/** What a surface holding a carrier renders and acts through. */
export interface AttachmentCarrierBinding {
  readonly snapshot: StagedAttachmentsSnapshot;
  readonly attachFiles: (files: readonly File[]) => void;
  readonly retry: (localId: string) => void;
  readonly abandon: (localId: string) => void;
}

/**
 * Bind one carrier to one component's lifetime.
 *
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION, which is what a carrier is
 * scoped to, so the console's own resource seam holds it: `useSubjectScopedResource`
 * opens the carrier on the render that first sees a `(bridge, session)` pair and
 * closes it however that render ended, including a pass React discards. It is also
 * what keeps this module off a second implementation of subject-scoped state.
 *
 * The `port` is read when the carrier opens, so it must stay the same for the life of
 * a `(bridge, session)` pair; a different port does not re-open the carrier.
 *
 * THE SEAM RE-MINTS A CLOSED CARRIER. React's StrictMode double-mount runs the seam's
 * cleanup and then this effect's setup again on the SAME committed carrier, and the
 * cleanup terminally disposes the ingest client. Left in place, every file the user
 * chose afterwards would reach a client whose `attach` returns at once: the attachment
 * surface inert, with nothing on screen to say so. The seam's `isClosed`, supplied
 * beside `close`, replaces it, so this effect starts a carrier and does nothing else.
 */
export function useAttachmentCarrier(
  bridge: ConsoleBridge,
  sessionId: SessionId,
  port: AttachmentIngestPort,
): AttachmentCarrierBinding {
  // The window's own clock, resolved once per bridge — `clone-expiry-wake-up.ts`'s
  // shape, for its reason: `consoleClockFor` mints a fresh `RealClock` per call on a
  // live bridge, so reading it in a render body would hand a re-minted carrier a
  // different instance from the one the first carrier was opened on.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: carrier } = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new StagedAttachments({ port, sessionId, clock }),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    carrier.start();
  }, [carrier]);
  const subscribe = useCallback(
    (onCarrierChange: () => void) => carrier.subscribe(onCarrierChange),
    [carrier],
  );
  const read = useCallback(() => carrier.snapshot, [carrier]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const attachFiles = useCallback(
    (files: readonly File[]) => {
      carrier.attachFiles(files);
    },
    [carrier],
  );
  const retry = useCallback(
    (localId: string) => {
      carrier.retry(localId);
    },
    [carrier],
  );
  const abandon = useCallback(
    (localId: string) => {
      carrier.abandon(localId);
    },
    [carrier],
  );
  return { snapshot, attachFiles, retry, abandon };
}
