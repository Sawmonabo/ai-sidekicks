// Builds the send controller for one addressed composer, so `SendButton.tsx` only renders.
//
// Status and refusal are held per address by `useComposerActState.ts`; the in-flight latch is
// claimed under `(bridge, addressedOperationKey(draftKey, visit, operation))` before the await
// and released in `finally`. The latch is not the status: a handler reads `status` from its
// own render, so two Enter presses in one frame would both read `idle`. The visit
// (`useSettlementIdentities.ts`) is carried by the latch claim, the attempt register and the
// settlement identity, so a return to an earlier address does not find a latch held by a parked
// call. A late settlement releases exactly the key it claimed, but its reading is dropped.
//
// The history walk and the comparand record are held here: the record must outlive the router,
// which is rebuilt whenever the addressed target changes, and the unsent body lives only in
// the supplied `DraftStore`.

import { useCallback, useMemo, useRef } from "react";

import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { normalizeWireRejection } from "@renderer/lib/wire/rejection.js";
import { composerDraftKey } from "../../draft-key.js";
import { useComposerActState } from "../../hooks/useComposerActState.js";
import { useSettlementIdentities } from "../../hooks/useSettlementIdentities.js";
import { composerRefusal, DAEMON_REFUSAL_ORIGIN } from "../refusals.js";
import { useSentMessageRecall } from "../../hooks/useSentMessageRecall.js";
import { addressedOperationKey } from "../settlement.js";
import { ComposerSendRouter } from "../router.js";
import { AnsweredRunVersions } from "@renderer/features/composer/answered-run-versions.js";
import type { SendController, SendControllerDependencies } from "../controller-contract.js";

/** What a recognized command with nowhere to run says; the text is still in the line. */
const NO_EXECUTOR_DETAIL =
  "That command was recognized but nothing here can run it, so " +
  "nothing happened. Your message is still in the line.";

/** Build the controller for one addressed composer. */
export function useSendController(dependencies: SendControllerDependencies): SendController {
  const { bridge, calls, target, draftStore, commandExecutor, recognizeConsoleCommand } =
    dependencies;
  // Allocated on first use, not on every render.
  const runVersionsRef = useRef<AnsweredRunVersions | null>(null);
  const runVersions = (runVersionsRef.current ??= new AnsweredRunVersions());
  const router = useMemo(
    () =>
      new ComposerSendRouter({
        calls,
        runVersions,
        ...(recognizeConsoleCommand === undefined ? {} : { recognizeConsoleCommand }),
      }),
    [calls, runVersions, recognizeConsoleCommand],
  );
  // Claimed before the await and released in `finally`, so every settlement releases the round
  // on one path.
  const operationLatch = useGenerationLatch();

  const draftKey = composerDraftKey(target);
  // Which stay at this address the composer is on, and the newest attempt of each act.
  const {
    visit,
    issue: issueSettlementIdentity,
    isCurrent,
  } = useSettlementIdentities(bridge, draftKey);
  // What the button renders while an act travels, held under the address it was issued at.
  const { status, refusal, publishStatus, settle, clearSentDraft } = useComposerActState(
    bridge,
    draftKey,
    draftStore,
    isCurrent,
  );

  // Read at press time rather than subscribed: nothing here renders the text.
  const readDraftText = useCallback(
    () => draftStore.read(draftKey)?.text ?? "",
    [draftStore, draftKey],
  );
  // The walk back through what was sent from this address, and the record a send writes into.
  const { history, recallOlder, recallNewer } = useSentMessageRecall(
    draftStore,
    draftKey,
    readDraftText,
  );

  const send = useCallback(async () => {
    const body = readDraftText();
    // Claimed for this address, so a send going to another target does not block this one. A
    // second press here is silent: the message is already going.
    const latchKey = addressedOperationKey(draftKey, visit, "send");
    const claim = operationLatch.claim(bridge, latchKey);
    if (claim === undefined) {
      return;
    }
    publishStatus("sending");
    // Captured before the await, so what settles is measured against the address sent from.
    const identity = issueSettlementIdentity("send");
    try {
      const routed = await router.send(body, target);
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
            return;
          case "send-as-typed":
            break;
        }
      }
      // A line its command did not act on goes out untrimmed, as any other message does.
      const outcome =
        routed.status === "intercepted" ? await router.sendAsTyped(body, target) : routed;
      switch (outcome.status) {
        case "sent":
          history.recordSent(body);
          // Clear only where the settlement is still current: the draft store is keyed by
          // address, not visit, so a return trip would erase text typed on the second visit.
          clearSentDraft(identity, draftKey);
          settle(identity, undefined);
          return;
        case "refused":
          settle(identity, outcome.refusal);
          return;
      }
    } catch (rejection) {
      // A rejected daemon call is held as the daemon's own refusal; the text stays in the line.
      settle(identity, normalizeWireRejection(DAEMON_REFUSAL_ORIGIN, rejection));
    } finally {
      // Releases the round this act claimed even after a re-address; the reading is published
      // through this address's publisher, so it lands only while the address is current.
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
    visit,
    clearSentDraft,
    commandExecutor,
    history,
    issueSettlementIdentity,
    operationLatch,
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
