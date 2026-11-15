// Builds the send controller for one session's composer, so `SendButton.tsx` only renders.
//
// A press takes what the draft holds, its words, its staged files, the files still copying and
// its skill picks, and makes it the message at once: the message's row lands in the transcript
// under the key its request carries, and the draft holds the next message from then on, so words
// typed while a file copies stay in it and a second press sends them as their own message. The
// session's messages leave for the service in press order (`send-order.ts`), each once the one
// before it has settled and its own files have copied, and the row settles under its key once the
// service has it. A message that fails comes back whole into its session's draft, ahead of anything
// typed since, with the caret where it stood, and one line in the transcript says why; a refused
// write back says so on that line. Sent while the draft edits a waiting message, it replaces that
// message in place under the row's own key, with the message's own files, and the draft gets back
// what it held before the edit; refused, the row goes back to its words and the edit's words to
// the draft. A send handed off, a message or a console word alike, pins the follow of the
// transcript mounted in this composer's window.
//
// A console command keeps its line until it acts, so its run holds the in-flight latch, claimed
// under `(bridge, visitOperationKey(draftKey, visit, operation))` before the await and released in
// `finally`, and the `sending` status. The visit (`useSettlementIdentities.ts`) is carried by the
// latch claim, the attempt register and the settlement identity, so a return to an earlier
// session does not find a latch held by a parked call. The history walk is held here, and the
// unsent body lives only in the supplied `DraftStore`.

import { useCallback, useMemo } from "react";

import type { AgentQueueItemCreateRequest, QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { SessionDraftExtras } from "@ai-sidekicks/contracts/session/draft";

import { useGenerationLatch } from "#renderer/hooks/useGenerationLatch.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { Clock } from "#renderer/lib/clock.js";
import { mountedTranscript } from "#renderer/registries/transcript/registry.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import { CALL_REJECTED_FALLBACK } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { composerDraftKey } from "../../draft-key.js";
import { refusalCause } from "#renderer/lib/code-words.js";
import type { DraftEdit, SentDraftExtras } from "#renderer/store/session/composer-requests.js";
import { useComposerActState } from "../../hooks/useComposerActState.js";
import { useSettlementIdentities } from "../../hooks/useSettlementIdentities.js";
import { composerRefusal, DAEMON_REFUSAL_ORIGIN, sendFailedLabel } from "../refusals.js";
import { useSentMessageRecall } from "../../hooks/useSentMessageRecall.js";
import { visitOperationKey, type ComposerSettlementIdentity } from "../settlement.js";
import { ComposerSendRouter, carriesNothing, type ComposerSendExtras } from "../router.js";
import { SEND_ORDER, SendOrder } from "../send-order.js";
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

  // A message leaves the draft at the press: its row lands under its key, what it carries leaves
  // the draft, which holds the next message from then on, and its request leaves for the service
  // once every message pressed before it has settled and the files it was pressed with have copied.
  const sendMessage = useCallback(
    async (
      body: string,
      request: AgentQueueItemCreateRequest,
      draftExtras: SessionDraftExtras,
      copies: readonly Promise<void>[],
    ): Promise<void> => {
      const identity = issueSettlementIdentity("send");
      // Where the caret stood at the press, where a message that comes back puts it again.
      const caret = lineCaret.read();
      const { sentMessages, composerRequests } = sessionStore;
      // The waiting message the draft edits, read at the press: the send replaces it in place.
      const edit = composerRequests.editSnapshot();
      const sentAt = instantOf(clock);
      // The edit keeps the row it edits, so the row never mounts twice.
      const key = edit?.rowKey ?? request.clientIdempotencyKey;
      const undoEdit =
        edit === undefined ? undefined : sentMessages.edit(key, body, sentAt, edit.queueItemId);
      if (edit === undefined) {
        sentMessages.press({ key, content: body, sentAt });
        draftStore.clear(draftKey);
      } else {
        draftStore.write(draftKey, edit.draftBefore);
        composerRequests.publishEdit(undefined);
      }
      const pressed = heldDraft.clearSent(draftExtras);
      const stagedAtPress = new Set(heldDraft.snapshot().extras.attachments ?? []);
      pinFollow(identity);
      let taken = pressed;
      try {
        const sendOrder = sessionStore.heldValues.valueOf(SEND_ORDER, () => new SendOrder());
        const queueItemId = await sendOrder.after(async () => {
          // A file dropped before the press goes with the message once its copy lands; with no copy
          // in flight at the press, a file staged since is the next message's.
          await Promise.allSettled(copies);
          const copiedIds =
            copies.length === 0
              ? []
              : (heldDraft.snapshot().extras.attachments ?? []).filter(
                  (artifactId) => !stagedAtPress.has(artifactId),
                );
          if (copiedIds.length > 0) {
            taken = joinedTaken(pressed, heldDraft.clearSent({ attachments: copiedIds }));
          }
          const attachments = [...(request.attachments ?? []), ...copiedIds];
          if (carriesNothing(body, { attachments })) {
            return undefined;
          }
          const created = await router.dispatch(
            attachments.length === 0 ? request : { ...request, attachments },
          );
          return created.queueItemId;
        });
        if (queueItemId === undefined) {
          // Its only file did not copy: nothing is sent, and the copy's own line says why.
          sentMessages.release(new Set([key]));
          undoEdit?.();
          return;
        }
        sentMessages.settle(key, queueItemId);
        history.recordSent(body);
        settle(identity, undefined);
      } catch (rejection) {
        // A rejected daemon call is held as the daemon's own refusal, its code kept for the remedy.
        const refusal = normalizeWireRejection(
          DAEMON_REFUSAL_ORIGIN,
          rejection,
          CALL_REJECTED_FALLBACK,
        );
        const label = sendFailedLabel(refusal, providerName);
        if (undoEdit === undefined) {
          sentMessages.fail({
            key,
            label,
            failedAt: instantOf(clock),
            afterEventId: selectTranscript(sessionStore.snapshot()).at(-1)?.id,
          });
        } else {
          // A refused edit leaves the waiting message as it was, in its own words.
          undoEdit();
        }
        raiseRefusalBanner(refusal);
        settle(identity, undefined);
        // Everything it carried goes back, ahead of anything typed since, with the caret where it
        // stood; a write back that is refused says so on the line.
        const handedBack = composerRequests.returnToDraft({ words: body, sent: taken });
        if (caret !== undefined && isCurrent(identity)) {
          lineCaret.place(caret);
        }
        const saveRefusal = await handedBack;
        if (saveRefusal !== undefined && undoEdit === undefined) {
          sentMessages.relabel(
            key,
            `${label} · ${refusalCause(saveRefusal.code, saveRefusal.reason, saveRefusal.detail)}`,
          );
        }
      }
    },
    [
      router,
      draftKey,
      draftStore,
      heldDraft,
      sessionStore,
      clock,
      providerName,
      lineCaret,
      raiseRefusalBanner,
      history,
      isCurrent,
      issueSettlementIdentity,
      pinFollow,
      settle,
    ],
  );

  // A console command keeps its line until it acts, so a second press while it runs is silent.
  const runCommand = useCallback(
    async (body: string, commandName: string, extras: SessionDraftExtras): Promise<void> => {
      const latchKey = visitOperationKey(draftKey, visit, "send");
      const claim = operationLatch.claim(bridge, latchKey);
      if (claim === undefined) {
        return;
      }
      publishStatus("sending");
      const identity = issueSettlementIdentity("send");
      try {
        if (commandExecutor === undefined) {
          settle(identity, composerRefusal("command-unexecutable", NO_EXECUTOR_DETAIL));
          return;
        }
        const settled = await commandExecutor({ commandName, text: body.trim() });
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
            // happened, on the same terms as a message's.
            clearSentDraft(identity, draftKey);
            settle(identity, undefined);
            pinFollow(identity);
            return;
          case "send-as-typed": {
            // A line its command did not act on goes out untrimmed, as any other message does.
            settle(identity, undefined);
            const message = router.resolveAsTyped(body, target, extras);
            if (message.outcome === "refused") {
              settle(identity, message.refusal);
              return;
            }
            await sendMessage(body, message.request, extras, heldDraft.copiesInFlight());
            return;
          }
        }
      } catch (rejection) {
        // A command's run rejected in its own words; the text stays in the line.
        settle(
          identity,
          normalizeWireRejection(DAEMON_REFUSAL_ORIGIN, rejection, CALL_REJECTED_FALLBACK),
        );
      } finally {
        // Releases the round this act claimed even after a switch of session; the reading is
        // published through this draft's publisher, so it lands only while the draft is current.
        claim.settle(() => {
          publishStatus("idle");
        });
        claim.release();
      }
    },
    [
      bridge,
      router,
      target,
      draftKey,
      heldDraft,
      visit,
      clearSentDraft,
      commandExecutor,
      issueSettlementIdentity,
      operationLatch,
      pinFollow,
      publishStatus,
      sendMessage,
      settle,
    ],
  );

  const send = useCallback(async () => {
    // What the draft holds at the press is the message: its words, the files staged and still
    // copying, and the skill picks. A press on a draft that holds nothing sends nothing.
    const body = readDraftText();
    const copies = heldDraft.copiesInFlight();
    const draftExtras = heldDraft.extrasFor(body);
    const extras = extrasWithEdit(draftExtras, sessionStore.composerRequests.editSnapshot());
    const resolution = router.resolve(body, target, extras);
    switch (resolution.outcome) {
      case "console-command":
        await runCommand(body, resolution.commandName, draftExtras);
        return;
      case "refused":
        settle(issueSettlementIdentity("send"), resolution.refusal);
        return;
      case "empty": {
        // Only a file still copying makes a press with no words a message.
        if (copies.length === 0) {
          return;
        }
        const message = router.resolveAsTyped(body, target, extras);
        if (message.outcome === "refused") {
          settle(issueSettlementIdentity("send"), message.refusal);
          return;
        }
        await sendMessage(body, message.request, draftExtras, copies);
        return;
      }
      case "queue":
        await sendMessage(body, resolution.request, draftExtras, copies);
        return;
    }
  }, [
    heldDraft,
    sessionStore,
    router,
    target,
    readDraftText,
    runCommand,
    sendMessage,
    settle,
    issueSettlementIdentity,
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
 * What rides with a message's words: the draft's extras and, for an edit of a waiting message, the
 * item it replaces in place and that item's own files ahead of any the draft holds.
 */
function extrasWithEdit(
  extras: SessionDraftExtras,
  edit: DraftEdit | undefined,
): ComposerSendExtras {
  if (edit === undefined) {
    return extras;
  }
  const attachments = [...edit.attachments, ...(extras.attachments ?? [])];
  return {
    ...extras,
    ...(attachments.length === 0 ? {} : { attachments }),
    replacesQueueItemId: heldIdAsWireId<QueueItemId>(edit.queueItemId),
  };
}

/** What a message took from the draft at the press, and the files its copies staged after. */
function joinedTaken(pressed: SentDraftExtras, copied: SentDraftExtras): SentDraftExtras {
  return {
    extras: {
      ...pressed.extras,
      attachments: [...(pressed.extras.attachments ?? []), ...(copied.extras.attachments ?? [])],
    },
    files: [...pressed.files, ...copied.files],
    callFormByPick: pressed.callFormByPick,
  };
}

/** Now on `clock`, as the ISO-8601 instant a transcript row's time is read from. */
function instantOf(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
