// The Send button's behaviour, so the button itself only renders.
//
// This package's structure rules put every construction, subscription, and
// derivation in a class or a hook. The router is a class and the history walk is a
// class; this hook is where they are BUILT and where the interaction state that
// binds them lives, which leaves `SendButton.tsx` as markup over one value.
//
// THE STATES ARE OBSERVABLE. Idle and Sending are `status`: Sending marks the control
// busy — deliberately, so a second press cannot queue a second turn.
// Refused is `refusal`. Sent is the wire's own row appearing in the transcript rather
// than a row this hook draws, which is why there is no `sent` member here to render.
//
// EVERY OPERATION STATE IS KEYED TO THE ADDRESS THE ACT WAS ISSUED AT, and the latch is
// not the status. `status` is what the surface RENDERS, and a handler reading it sees
// the value from the render that produced it — so two Enter presses in one frame would
// both read `idle` and both dispatch. Neither is hook-wide: a send still travelling for
// one target does not hold the composer when the person re-addresses it. Both halves
// are keyed through the holders `console/bridge/` publishes rather than through
// anything local: the console's one `GenerationLatch` holds the slot under
// `(bridge, addressedOperationKey(draftKey, visit, operation))`, claimed before the
// await and released in `finally`, and `use-composer-act-state.ts` beside this file
// holds `status` under `(bridge, draftKey)`, reset during the render that first sees a
// new address.
//
// THE VISIT IS WHAT KEEPS THE LATCH AND THE STATUS SAYING THE SAME THING. The holder
// re-seeds on every re-address, including a return to a target the composer has been
// on before; a latch keyed on the draft key alone would not, so on the return trip
// the button would render `idle` over a slot still held by the earlier visit's parked
// call and Send would do nothing. `use-settlement-identities.ts` owns that serial and
// says why it is the composer's mirror of the holder's own addressing epoch; every
// keyed thing here carries it — the latch slot, the newest-attempt register, and the
// settlement identity — so the three agree by construction rather than by three
// authors remembering the same rule. Their dispositions for a late settlement differ,
// deliberately: it releases the exact slot it claimed even after the composer has
// moved on, while the READING it would have published is dropped — that reading
// describes an act at an address this composer has left.
//
// THE HISTORY WALK IS PER ADDRESS FOR THE SAME REASON. A single history for the life
// of the mounted button would carry an address's sent messages, and any walk in
// progress, into the next address the button is rebound to.
// `AddressedDirectiveHistories` keys them on the same draft key, so the composer walks
// the history of the target it is addressed to and no other.
//
// WHAT THE SURFACE READS WHILE AN ACT TRAVELS IS ITS OWN MODULE. The status and the
// refusal the button renders are two holders under one address, and
// `use-composer-act-state.ts` beside this file owns them together with the writers a
// settlement reaches them by. This hook BUILDS the acts — the router, the latch, the
// dispatch path, the history walk — and READS that state; the two jobs have different
// lifetimes and different failure modes, and one file answering both is a file where
// neither is legible. `send-settlement.ts` owns which act a settlement belongs to, and
// `use-settlement-identities.ts` owns whether that act is still the one on screen.
//
// THE COMPARAND LEDGER OUTLIVES THE ROUTER, and it has to. The router is memoized on
// the command zone's predicates, and those change identity whenever the addressed
// target does — which is on every store notification, a landed steer's own run rows
// included. A ledger inside the router would therefore be emptied between exactly
// the two steers it exists to bridge, so this hook holds it and hands it in, the way
// it holds the per-address histories.
//
// THE UNSENT BODY LIVES IN THE SUPPLIED `DraftStore` AND NOWHERE ELSE. The
// workspace hands the composer seat a window-lifetime store, keyed per address; a
// `useState` string here would be a second home for the same text, and the two
// differ exactly where it matters — a remount loses the local copy, and a prop-only
// address change keeps it, so the person's words reappear under a target they did
// not write them for.

import { useCallback, useMemo, useRef } from "react";

import { useGenerationLatch } from "@renderer/console/store/read/generation-latch.js";
import { composerDraftKey } from "../draft-key.js";
import { useComposerActState } from "./useComposerActState.js";
import { useComposerDraftText } from "../../hooks/useComposerDraftText.js";
import { useSettlementIdentities } from "./useSettlementIdentities.js";
import { composerRefusal } from "../send-refusals.js";
import { composeDirectivePlaceholder } from "../draft-line.js";
import { useDirectiveRecall } from "./useSentMessageRecall.js";
import { addressedOperationKey } from "../send-settlement.js";
import { ComposerSendRouter } from "../send-router.js";
import { RunVersionLedger } from "../answered-run-versions.js";
import type { SendController, SendControllerDependencies } from "../send-controller-contract.js";

/**
 * What a recognised command with nowhere to run says.
 *
 * Names the state rather than the wiring: a person cannot act on "no executor was
 * supplied", and can act on knowing their text is still there and the command did
 * not run.
 */
const NO_EXECUTOR_DETAIL =
  "That command was recognised but nothing here can run it, so nothing happened. Your message is still in the line.";

/** Build the controller for one addressed composer. */
export function useSendController(dependencies: SendControllerDependencies): SendController {
  const {
    bridge,
    calls,
    target,
    draftStore,
    commandExecutor,
    recognizeClientCommand,
    recognizeProviderCommand,
  } = dependencies;
  // Allocated on first use rather than on every render, which a bare initialiser
  // would do and then discard.
  const runVersionsRef = useRef<RunVersionLedger | null>(null);
  const runVersions = (runVersionsRef.current ??= new RunVersionLedger());
  const router = useMemo(
    () =>
      new ComposerSendRouter({
        calls,
        runVersions,
        ...(recognizeClientCommand === undefined ? {} : { recognizeClientCommand }),
        ...(recognizeProviderCommand === undefined ? {} : { recognizeProviderCommand }),
      }),
    [calls, runVersions, recognizeClientCommand, recognizeProviderCommand],
  );
  // Claimed before the await and released in `finally`, so every settlement — sent,
  // intercepted, refused, or a rejected call — releases the round on exactly one path
  // rather than on the arms an author remembered.
  const operationLatch = useGenerationLatch();

  const draftKey = composerDraftKey(target);
  // Which stay at this address the composer is on, and which attempt of each act is
  // the newest. Its own module because it is a different job with a different
  // lifetime: nothing there reaches a wire or renders anything.
  const {
    visit,
    issue: issueSettlementIdentity,
    isCurrent,
  } = useSettlementIdentities(bridge, draftKey);
  // What the button renders while an act is travelling, held under the address that act
  // was issued at, and the two writers a settlement reaches it by. Its own module
  // because it is a different job with a different lifetime: nothing there reaches a
  // wire, and every reading in it is dropped by a re-address or a replaced bridge.
  const { status, refusal, publishStatus, clearRefusals, settle, clearSentDraft } =
    useComposerActState(bridge, draftKey, draftStore, isCurrent);

  // The one reading of this key, shared with the discovery popover watching the same
  // line: two subscriptions written twice are two answers to what the person typed.
  const { text, read: readDraftText } = useComposerDraftText(draftStore, draftKey);
  // The walk back through what was sent from this address, and the record a settled
  // send writes into. Its own module because it is a different job with a different
  // lifetime — nothing there reaches the wire and nothing there can refuse.
  const { history, recallOlder, recallNewer } = useDirectiveRecall(
    draftStore,
    draftKey,
    readDraftText,
  );

  const changeText = useCallback(
    (next: string) => {
      draftStore.write(draftKey, next);
      // A refusal answers the act that produced it, so the next edit clears it:
      // leaving it up would make a stale refusal read as a verdict on text nobody has
      // sent.
      clearRefusals();
    },
    [draftStore, draftKey, clearRefusals],
  );

  const send = useCallback(async () => {
    const body = readDraftText();
    // Claimed for THIS address, so a message already going to another target is no
    // reason to refuse this one. A second press at this address is silent rather
    // than refused: the person pressed Send for the message that is already going,
    // and a refusal card would report a failure where the only thing that happened
    // is that they were early.
    const latchKey = addressedOperationKey(draftKey, visit, "send");
    const claim = operationLatch.claim(bridge, latchKey);
    if (claim === undefined) {
      return;
    }
    publishStatus("sending");
    // Captured BEFORE the await, so what settles is measured against the address the
    // person sent from rather than the one they are looking at when it lands.
    const identity = issueSettlementIdentity("send");
    try {
      const outcome = await router.send(body, target);
      switch (outcome.status) {
        case "sent":
          history.recordSent(body);
          // THE DRAFT CLEARS ONLY WHERE THE SETTLEMENT IS STILL THE ONE ON SCREEN.
          // The draft store is keyed by ADDRESS and not by visit, so on a return
          // trip the captured key names a different draft with the same name: an
          // unconditional clear would erase text the person typed on the second visit
          // to answer a send made on the first.
          clearSentDraft(identity, draftKey);
          settle(identity, undefined);
          return;
        case "intercepted": {
          if (commandExecutor === undefined) {
            settle(identity, composerRefusal("command-unexecutable", NO_EXECUTOR_DETAIL));
            return;
          }
          const settled = await commandExecutor({
            commandName: outcome.commandName,
            text: body.trim(),
          });
          if (settled.status === "refused") {
            // The line is kept: the command did not run, and the text is the one
            // thing the person would otherwise have to retype to try again.
            settle(identity, settled.refusal);
            return;
          }
          if (settled.status === "not-run") {
            // Kept for the same reason, and said nothing about: the command reads
            // its arguments off this line and nothing here can perform it.
            settle(identity, undefined);
            return;
          }
          // A registered command never composes into a message: the line is
          // cleared because the act happened, and nothing was sent — and on the
          // same terms as the sent arm, so a command settling after the composer
          // has left and returned does not erase what was typed since.
          clearSentDraft(identity, draftKey);
          settle(identity, undefined);
          return;
        }
        case "refused":
          settle(identity, outcome.refusal);
          return;
      }
    } finally {
      // The round released is the one this act claimed, which is what lets a
      // settlement arriving after a re-address free the address it was issued at
      // rather than the one on screen. The reading is published through this
      // address's own publisher, so it lands only while that address is current.
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
    text,
    placeholder: composeDirectivePlaceholder(),
    status,
    refusal,
    changeText,
    send,
    recallOlder,
    recallNewer,
  };
}
