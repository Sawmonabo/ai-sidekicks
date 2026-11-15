// Builds the send controller for one session's composer, so `SendButton.tsx` only renders.
//
// Status and refusal are held per session's draft by `useComposerActState.ts`; the in-flight
// latch is claimed under `(bridge, visitOperationKey(draftKey, visit, operation))` before the
// await and released in `finally`. The latch is not the status: a handler reads `status` from its
// own render, so two Enter presses in one frame would both read `idle`. The visit
// (`useSettlementIdentities.ts`) is carried by the latch claim, the attempt register and the
// settlement identity, so a return to an earlier session does not find a latch held by a parked
// call. A late settlement releases exactly the key it claimed, but its reading is dropped.
//
// The history walk is held here, and the unsent body lives only in the supplied `DraftStore`; what
// rides with it is the supplied held draft's, read at the press.
//
// A message is in the session's transcript the moment it leaves: the words and what rides with
// them leave the composer, and the row settles under the same key once the service has it. A
// message that fails comes back: its row leaves the transcript, the words, files and skill picks
// go back into the composer with the caret where it stood, and one line in the transcript says
// why. Sent while the draft edits a waiting message, it replaces that message in place under the
// row's own key, and the draft gets back what it held before the edit; refused, the row goes back
// to its words and the edit's words to the draft. A send handed off, a message or a console word
// alike, pins the follow of the transcript mounted in this composer's window, so the reader is
// taken to the bottom whatever they had scrolled to.

import { useCallback, useMemo } from "react";

import type { AgentQueueItemCreateRequest, QueueItemId } from "@ai-sidekicks/contracts/run/queue";

import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { Clock } from "#renderer/lib/clock.js";
import { mountedTranscript } from "#renderer/registries/transcript/registry.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import { CALL_REJECTED_FALLBACK } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { returnWordsToDraft } from "../../returned-words.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { composerDraftKey } from "../../draft-key.js";
import type { SentDraftExtras } from "#renderer/features/composer/held-draft/holder.js";
import { useComposerActState } from "../../hooks/useComposerActState.js";
import { useSettlementIdentities } from "../../hooks/useSettlementIdentities.js";
import { composerRefusal, DAEMON_REFUSAL_ORIGIN, sendFailedLabel } from "../refusals.js";
import { useSentMessageRecall } from "../../hooks/useSentMessageRecall.js";
import { visitOperationKey, type ComposerSettlementIdentity } from "../settlement.js";
import { ComposerSendRouter, carriesNothing, type ComposerSendExtras } from "../router.js";
import type { SendController, SendControllerDependencies } from "../controller-contract.js";

/** What a recognized command with nowhere to run says; the text is still in the line. */
const NO_EXECUTOR_DETAIL =
  "That command was recognized but nothing here can run it, so " +
  "nothing happened. The message is still in the line.";

/** Build the controller for one session's composer. */
export function useSendController(dependencies: SendControllerDependencies): SendController {
  const {
    bridge,
    calls,
    target,
    draftStore,
    heldDraft,
    sessionStore,
    clock,
    providerName,
    lineCaret,
    raiseRefusalBanner,
    commandExecutor,
    recognizeConsoleCommand,
  } = dependencies;
  const router = useMemo(
    () =>
      new ComposerSendRouter({
        calls,
        ...(recognizeConsoleCommand === undefined ? {} : { recognizeConsoleCommand }),
      }),
    [calls, recognizeConsoleCommand],
  );
  // Claimed before the await and released in `finally`, so every settlement releases the round
  // on one path.
  const operationLatch = useGenerationLatch();
  const ownerDocument = useOwnerWindow().document;

  const draftKey = composerDraftKey(target.sessionId);
  // Which stay at this session the composer is on, and the newest attempt of each act.
  const {
    visit,
    issue: issueSettlementIdentity,
    isCurrent,
  } = useSettlementIdentities(bridge, draftKey);
  // What the button renders while an act travels, held under the draft it was issued from.
  const { status, refusal, publishStatus, settle, clearSentDraft } = useComposerActState(
    bridge,
    draftKey,
    draftStore,
    isCurrent,
  );

  // A send handed off from this visit takes its window's transcript to the bottom and pins the
  // follow there. A late settlement leaves the session now in view where its reader is, and a
  // window with no transcript mounted has no follow to pin, so the holder's refusal says nothing.
  const pinFollow = useCallback(
    (identity: ComposerSettlementIdentity) => {
      if (isCurrent(identity)) {
        mountedTranscript.perform("jumpToLatest", ownerDocument);
      }
    },
    [isCurrent, ownerDocument],
  );

  // Read at press time rather than subscribed: nothing here renders the text.
  const readDraftText = useCallback(
    () => draftStore.read(draftKey)?.text ?? "",
    [draftStore, draftKey],
  );
  // The walk back through what was sent from this session, and the record a send writes into.
  const { history, recallOlder, recallNewer } = useSentMessageRecall(
    draftStore,
    draftKey,
    readDraftText,
  );

  const send = useCallback(async () => {
    const body = readDraftText();
    // A message carrying nothing does nothing and draws nothing, not even the sending state; one
    // whose file is still copying waits for the copy, and the router answers what is left.
    if (!heldDraft.isCopying && carriesNothing(body, heldDraft.extrasFor(body))) {
      return;
    }
    // Claimed for this session's draft, so a send from another session does not block this one.
    // A second press here is silent: the message is already going.
    const latchKey = visitOperationKey(draftKey, visit, "send");
    const claim = operationLatch.claim(bridge, latchKey);
    if (claim === undefined) {
      return;
    }
    publishStatus("sending");
    // Captured before the await, so what settles is measured against the draft sent from.
    const identity = issueSettlementIdentity("send");
    // Where the caret stood at the press, where a message that comes back puts it again.
    const caret = lineCaret.read();
    // The message as it left, once it has: what it took from the composer, under its row's key.
    const dispatched: { message: DispatchedMessage | undefined } = { message: undefined };
    try {
      // A file dropped just before the press is still copying; the message waits and carries it.
      await heldDraft.whenCopied();
      // The waiting message the draft edits, read at the press: the send replaces it in place.
      const edit = sessionStore.composerRequests.editSnapshot();
      const extras: ComposerSendExtras =
        edit === undefined
          ? heldDraft.extrasFor(body)
          : {
              ...heldDraft.extrasFor(body),
              replacesQueueItemId: heldIdAsWireId<QueueItemId>(edit.queueItemId),
            };
      // The message leaves the composer for the transcript as its request leaves for the service.
      const onDispatch = (request: AgentQueueItemCreateRequest): void => {
        const sentAt = instantOf(clock);
        let key: string = request.clientIdempotencyKey;
        let undoEdit: (() => void) | undefined;
        if (edit === undefined) {
          sessionStore.sentMessages.press({ key, content: request.content, sentAt });
        } else {
          // The edit keeps the row it edits, so the row never mounts twice.
          key = edit.rowKey;
          undoEdit = sessionStore.sentMessages.edit(key, request.content, sentAt, edit.queueItemId);
        }
        clearSentDraft(identity, draftKey);
        dispatched.message = { key, taken: heldDraft.clearSent(extras), undoEdit };
        if (edit !== undefined) {
          draftStore.write(draftKey, edit.draftBefore);
          sessionStore.composerRequests.publishEdit(undefined);
        }
        pinFollow(identity);
      };
      const routed = await router.send(body, target, extras, onDispatch);
      if (routed.status === "empty") {
        // Nothing to send: Send is already dimmed, and no line is drawn for the press.
        settle(identity, undefined);
        return;
      }
      if (routed.status === "intercepted") {
        if (commandExecutor === undefined) {
          settle(identity, composerRefusal("command-unexecutable", NO_EXECUTOR_DETAIL));
          return;
        }
        const settled = await commandExecutor({
          commandName: routed.commandName,
          text: body.trim(),
        });
        switch (settled.status) {
          case "refused":
            // Kept: the text is what the person would otherwise retype.
            settle(identity, settled.refusal);
            return;
          case "not-run":
            // Kept too: the command reads its arguments off this line.
            settle(identity, undefined);
            return;
          case "applied":
            // A command never composes into a message: the line clears because the act
            // happened, on the same terms as the sent arm.
            clearSentDraft(identity, draftKey);
            settle(identity, undefined);
            pinFollow(identity);
            return;
          case "send-as-typed":
            break;
        }
      }
      // A line its command did not act on goes out untrimmed, as any other message does.
      const outcome =
        routed.status === "intercepted"
          ? await router.sendAsTyped(body, target, extras, onDispatch)
          : routed;
      switch (outcome.status) {
        case "sent":
          if (dispatched.message !== undefined) {
            sessionStore.sentMessages.settle(dispatched.message.key, outcome.queueItemId);
          }
          history.recordSent(body);
          settle(identity, undefined);
          return;
        case "refused":
          settle(identity, outcome.refusal);
          return;
      }
    } catch (rejection) {
      // A rejected daemon call is held as the daemon's own refusal, its code kept for the remedy.
      const refusal = normalizeWireRejection(
        DAEMON_REFUSAL_ORIGIN,
        rejection,
        CALL_REJECTED_FALLBACK,
      );
      const message = dispatched.message;
      if (message === undefined) {
        // A file's copy or a command's run rejected in its own words; the text stays in the line.
        settle(identity, refusal);
        return;
      }
      // The words go back ahead of anything typed since, with the caret where it stood.
      returnWordsToDraft(draftStore, draftKey, body);
      heldDraft.restoreSent(message.taken);
      if (caret !== undefined && isCurrent(identity)) {
        lineCaret.place(caret);
      }
      if (message.undoEdit === undefined) {
        sessionStore.sentMessages.fail({
          key: message.key,
          label: sendFailedLabel(refusal, providerName),
          failedAt: instantOf(clock),
          afterEventId: selectTranscript(sessionStore.snapshot()).at(-1)?.id,
        });
      } else {
        // A refused edit leaves the waiting message as it was, in its own words.
        message.undoEdit();
      }
      raiseRefusalBanner(refusal);
      settle(identity, undefined);
    } finally {
      // Releases the round this act claimed even after a switch of session; the reading is
      // published through this draft's publisher, so it lands only while the draft is current.
      claim.settle(() => {
        publishStatus("idle");
      });
      claim.release();
    }
  }, [
    bridge,
    router,
    target,
    draftKey,
    draftStore,
    heldDraft,
    sessionStore,
    clock,
    providerName,
    lineCaret,
    raiseRefusalBanner,
    visit,
    clearSentDraft,
    commandExecutor,
    history,
    isCurrent,
    issueSettlementIdentity,
    operationLatch,
    pinFollow,
    publishStatus,
    readDraftText,
    settle,
  ]);

  return {
    status,
    refusal,
    send,
    recallOlder,
    recallNewer,
  };
}

/**
 * A message that left: its transcript row's key, what it took from the held draft, and for an
 * edit what puts the row back as it was.
 */
interface DispatchedMessage {
  readonly key: string;
  readonly taken: SentDraftExtras;
  readonly undoEdit: (() => void) | undefined;
}

/** Now on `clock`, as the ISO-8601 instant a transcript row's time is read from. */
function instantOf(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
