// The composer host: the region, and the palette's replace question, the attachment strip, the
// draft line with Send, the command list, the toolbar with its chips and Attach, and the strip
// under it, mounted in that order. It owns the provider-command enumeration holder and hands it to the command list, whose
// enumeration is read live and never cached; it follows and saves the session's held draft, whose
// words land in the line and whose skill picks and staged files ride with them; it contributes the
// lead's run controls to the palette; and it answers Ctrl+B for its session.

import { useMemo, useRef } from "react";

import { type ComposerProps } from "#renderer/registries/composer/registry.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { ComposerAttachmentStrip } from "./attachments/components/ComposerAttachmentStrip.js";
import { useComposerStaging } from "./attachments/hooks/useComposerStaging.js";
import { SpeedChip } from "./chips/components/SpeedChip.js";
import { ToolServersChip } from "./chips/components/ToolServersChip.js";
import { readComposerCommands } from "./command-list/registry-view.js";
import { ComposerStrip } from "./strip/components/ComposerStrip.js";
import { ComposerToolbar } from "./components/ComposerToolbar.js";
import { CommandList } from "./command-list/components/CommandList.js";
import { ProviderCommandEnumeration } from "./command-list/provider/enumeration.js";
import { WorkflowStartPrefillQuestion } from "./command-list/workflow/components/WorkflowStartPrefillQuestion.js";
import { useWorkflowStartPrefill } from "./command-list/workflow/hooks/useWorkflowStartPrefill.js";
import { workflowStartOperationsOver } from "./command-list/workflow/start-from-line.js";
import { composerDraftKey } from "./draft-line/draft-key.js";
import { useCarryComposerChromeHeight } from "./hooks/useCarryComposerChromeHeight.js";
import { useHeldDraft } from "./hooks/useHeldDraft.js";
import { useMoveToBackground } from "./hooks/useMoveToBackground.js";
import { DraftLine } from "./draft-line/components/DraftLine.js";
import { SendButton } from "./draft-line/components/SendButton.js";
import type { ComposerSendCalls } from "./draft-line/send/dispatch.js";
import { useLeadRunControlCommands } from "./run/controls/hooks/useLeadRunControlCommands.js";
import "./Composer.css";

/** Module-level so the resource holder is handed a stable opener. */
function openEnumeration(): ProviderCommandEnumeration {
  return new ProviderCommandEnumeration();
}

/**
 * Releases the enumeration without ending it: `close()` supersedes any outstanding read and a
 * later `open()` reads again, so there is no closed state to report. Module-level so hook
 * dependency lists see one identity.
 */
const enumerationDisposal: SubjectScopedDisposal<ProviderCommandEnumeration> = {
  release: (enumeration: ProviderCommandEnumeration): void => {
    enumeration.close();
  },
};

/** The composer for one session. */
export function MessageComposer(props: ComposerProps): React.JSX.Element {
  const regionRef = useRef<HTMLElement | null>(null);
  const draftScrollerRef = useRef<HTMLDivElement | null>(null);
  useCarryComposerChromeHeight(regionRef, draftScrollerRef);
  // One holder per addressed composer, never shared across sessions (the enumeration is not
  // cached). It survives a bridge swap under the same session: the holder's key compares the
  // bridge by identity, so a replaced bridge re-reads instead of serving the old catalog. Held as
  // a resource, not a `useMemo`: React may discard a memoized value and re-run the factory, which
  // would leave a holder with an open read that nothing ever closes.
  const { value: commandEnumeration } = useSubjectScopedResource<ProviderCommandEnumeration>(
    props.sessionStore,
    props.sessionStore.sessionId,
    openEnumeration,
    enumerationDisposal,
  );
  // The palette entry that types the command word onto this composer's line, and the question
  // it asks above the draft before replacing unsent words.
  const draftKey = composerDraftKey(props.sessionStore.sessionId);
  const prefillPrompt = useWorkflowStartPrefill({ draftStore: props.draftStore, draftKey });
  const { heldDraft, reading } = useHeldDraft(
    props.bridge,
    props.sessionStore.sessionId,
    props.draftStore,
  );
  const backgroundRefusal = useMoveToBackground(props.bridge, props.sessionStore.sessionId);
  useLeadRunControlCommands(props.bridge, props.sessionStore);
  const sendCalls = useMemo(() => sendCallsOver(props.bridge), [props.bridge]);
  const workflowStartOperations = useMemo(
    () => workflowStartOperationsOver(props.bridge),
    [props.bridge],
  );
  const wireSessionId = readSessionId(props.sessionStore.sessionId);
  const staging = useComposerStaging(props.bridge, wireSessionId, regionRef, heldDraft);
  return (
    <section className="meridian-composer" aria-label="Message composer" ref={regionRef}>
      <WorkflowStartPrefillQuestion prompt={prefillPrompt} />
      {staging === undefined ? null : (
        <ComposerAttachmentStrip
          files={reading.files}
          staging={staging.staging}
          snapshot={staging.snapshot}
          isDraggingFiles={staging.isDraggingFiles}
        />
      )}
      <DraftLine
        {...props}
        scrollerRef={draftScrollerRef}
        send={
          <SendButton
            {...props}
            calls={sendCalls}
            workflowStartOperations={workflowStartOperations}
            heldDraft={heldDraft}
            region={regionRef}
          />
        }
      />
      {reading.saveRefusal === undefined ? null : (
        <InlineRefusal code={reading.saveRefusal.code} detail={reading.saveRefusal.detail} />
      )}
      {backgroundRefusal === undefined ? null : (
        <InlineRefusal code={backgroundRefusal.code} detail={backgroundRefusal.detail} />
      )}
      <CommandList
        {...props}
        region={regionRef}
        commandEnumeration={commandEnumeration}
        heldDraft={heldDraft}
      />
      {wireSessionId === undefined || staging === undefined ? (
        <ComposerToolbar {...props} />
      ) : (
        <>
          <ComposerToolbar
            {...props}
            chips={
              <>
                <SpeedChip bridge={props.bridge} sessionId={wireSessionId} heldDraft={heldDraft} />
                <ToolServersChip
                  bridge={props.bridge}
                  sessionId={wireSessionId}
                  frameStore={props.frameStore}
                />
              </>
            }
            attach={
              <button
                type="button"
                className="meridian-composer__attach"
                aria-label="Attach"
                onClick={staging.pickFiles}
              >
                <Glyph name="paperclip" />
              </button>
            }
          />
          <ComposerStrip
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            sessionId={wireSessionId}
            openDetails={() => {
              readComposerCommands(props.route).invoke("paneLayout.openInspector");
            }}
          />
        </>
      )}
    </section>
  );
}

/** The send call over the daemon; a refused send rejects with the daemon's refusal. */
function sendCallsOver(bridge: PlatformBridge): ComposerSendCalls {
  return {
    queueCreate: async (request) =>
      unwrapDaemonReply(await callDaemon(bridge, "agent.queueItem.create", request)),
  };
}
