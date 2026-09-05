// The send bar's behaviour, so the send bar itself only renders.
//
// This package's structure rules put every construction, subscription, and
// derivation in a class or a hook. The router is a class and the history walk is a
// class; this hook is where they are BUILT and where the interaction state that
// binds them lives, which leaves `ComposerSendBar.tsx` as markup over one value.
//
// FOUR STATES, AND EACH ONE IS OBSERVABLE. `Spec-023 §Console Design (Meridian)`
// gives the composer Idle, Typing, Sending, Sent, and Refused. Sending locks the
// line and marks the control busy — deliberately, so a second Enter cannot queue a
// second turn — and Sent is the wire's own row appearing in the ledger rather than
// a row this hook draws, which is why there is no `sent` member here to render.
//
// EVERY OPERATION STATE IS KEYED TO THE ADDRESS THE ACT WAS ISSUED AT, and the
// latch is not the status. `status` is what the surface RENDERS, and a handler
// reading it sees the value from the render that produced it — so two Enter presses
// in one frame both read `idle` and both dispatch. Both were also hook-wide, so a
// send or a Stop still travelling for one target held the composer as the person
// re-addressed it: the new target's line stayed read-only and its own control
// unavailable until the previous call settled. Both halves are keyed through the
// holders `console/bridge/` publishes rather than through anything local: the
// console's one `GenerationLatch` holds the slot under `(bridge,
// addressedOperationKey(draftKey, visit, operation))`, claimed before the await and
// released in `finally`, and `useSubjectScopedState` holds `status` and `isStopping`
// under `(bridge, draftKey)`, reset during the render that first sees a new
// address.
//
// THE VISIT IS WHAT KEEPS THE LATCH AND THE STATUS SAYING THE SAME THING. The holder
// re-seeds on every re-address, including a return to a target the composer has been
// on before; a latch keyed on the draft key alone did not, so on the return trip the
// bar rendered `idle` over a slot still held by the earlier visit's parked call and
// Send did nothing at all. `use-settlement-register.ts` owns that serial and says
// why it is the composer's mirror of the holder's own addressing epoch; every keyed
// thing here carries it — the latch slot, the newest-attempt register, and the
// settlement identity — so the three agree by construction rather than by three
// authors remembering the same rule. Their dispositions for a late settlement
// differ, deliberately: it releases the exact slot it claimed even after the
// composer has moved on, while the READING it would have published is dropped —
// that reading describes an act at an address this composer is no longer on.
//
// THE DISCLOSURE IS MADE WHERE IT IS TRUE. The store arms a sentence about unsent
// text — "not saved between restarts" — and the composer used to render it from the
// moment it mounted, so every composer nobody had touched carried a line about text
// nobody had typed, on every window and in every captured pixel. `Spec-023 §Console
// Design (Meridian)` §Persistence has the composer "say so on first focus after a
// restart", so first focus is what ARMS it and the line holding unsent text is what
// shows it: the sentence appears when there is something for it to be about. The
// store's flag is still consumed at that first focus, so a window tells one composer
// and no other repeats it.
//
// STOP HAS ITS OWN SLOT AND NOT THE SEND ONE. `driver.interruptRun` is not
// idempotent: a second press issues a second interrupt, and once the first has
// retired the active turn the duplicate refuses with no live run — a misleading
// refusal standing beside an interrupt that worked. So Stop claims a slot of its
// own, which is what carrying the OPERATION in the latch key buys: interrupting a
// turn while a send is in flight is exactly what the control exists for. A second
// press while the first is held is silent, as `dispatch`'s own is.
//
// THE HISTORY WALK IS PER ADDRESS FOR THE SAME REASON. One history for the life of
// the mounted bar carried an address's sent messages, and any walk in progress, into
// the next address the bar was rebound to. `AddressedDirectiveHistories` keys them
// on the same draft key, so the composer walks the history of the target it is
// addressed to and no other.
//
// THE RESEND OFFER AND THE REFUSAL ARE HELD WHERE THE STATUS IS. The tripwire card
// offers the last sent body so a neutralized turn can be retried without retyping,
// and the refusal answers the act that produced it — and both used to be hook-wide
// `useState` guarded by a read-time comparison against the current draft key. A
// guard only HIDES: the row was still there, so the return trip offered one agent's
// words under another's run and rendered a refusal minutes old, and a bridge
// replacement — which retires every call made through the old transport — left both
// standing. They are now held under `(bridge, draftKey)` like `status` and
// `isStopping`, so a re-address drops them and a replaced bridge takes them with it.
// `send-settlement.ts` still owns which act a settlement belongs to, and
// `use-settlement-register.ts` owns whether that act is still the one on screen.
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
// not write them for. Reading through the store is also what makes the store's own
// restart disclosure reachable: it is armed at construction and cleared the first
// time a composer is focused, which is a sentence somebody has to render.

import { useCallback, useMemo, useRef } from "react";

import type { ConsoleRefusal } from "../../../console/core/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../console/store/index.js";
import { composerDraftKey } from "./draft-key.js";
import { useComposerDraftText } from "../use-composer-draft-text.js";
import { useSettlementRegister } from "./use-settlement-register.js";
import { composerRefusal } from "./send-refusals.js";
import { composeDirectivePlaceholder, directivePathLabel } from "./directive-line.js";
import { useDirectiveRecall } from "./use-directive-recall.js";
import { useRestartDisclosure } from "./use-restart-disclosure.js";
import {
  NO_COMPOSER_REFUSALS,
  addressedOperationKey,
  renderableRefusal,
  withSettledRefusal,
  type ComposerRefusalSlots,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";
import { ComposerSendRouter } from "./send-router.js";
import { RunVersionLedger } from "./run-version-ledger.js";
import type {
  SendController,
  SendControllerDependencies,
  SendControllerStatus,
} from "./send-controller-contract.js";

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
        bridge,
        runVersions,
        ...(recognizeClientCommand === undefined ? {} : { recognizeClientCommand }),
        ...(recognizeProviderCommand === undefined ? {} : { recognizeProviderCommand }),
      }),
    [bridge, runVersions, recognizeClientCommand, recognizeProviderCommand],
  );
  // Claimed before the await and released in `finally`, so every settlement — sent,
  // intercepted, refused, or a rejection the router turned into a refusal — releases
  // the round on exactly one path rather than on the arms an author remembered.
  const operationLatch = useGenerationLatch();

  const draftKey = composerDraftKey(target);
  // Which stay at this address the composer is on, and which attempt of each act is
  // the newest. Its own module because it is a different job with a different
  // lifetime: nothing there reaches a wire or renders anything.
  const { visit, issue: issueSettlementIdentity, isCurrent } = useSettlementRegister(draftKey);
  // What the bar renders while an act is travelling, held under the address that act
  // was issued at. Two holders rather than one object: a send and a Stop can be in
  // flight at once, and one publisher writing a pair would let whichever settled
  // second overwrite what the other had just said.
  const { value: status, publish: publishStatus } = useSubjectScopedState<SendControllerStatus>(
    bridge,
    draftKey,
    () => "idle",
  );
  const { value: isStopping, publish: publishStopping } = useSubjectScopedState(
    bridge,
    draftKey,
    () => false,
  );
  // Held under the SAME subject and key the status is, and for the same two reasons.
  // A bridge replacement retires every call made through the old transport, so a
  // refusal it raised and an offer to resend its body are both about a transport
  // that no longer exists — as `useState` they survived it, and pressing Resend sent
  // the old body through the new bridge. And a re-address re-seeds them, so a
  // refusal is DROPPED rather than hidden behind a read-time guard that let the
  // return trip render it again.
  const { value: refusalSlots, publish: publishRefusalSlots } =
    useSubjectScopedState<ComposerRefusalSlots>(bridge, draftKey, () => NO_COMPOSER_REFUSALS);
  const { value: resendOffer, publish: publishResendOffer } = useSubjectScopedState<
    string | undefined
  >(bridge, draftKey, () => undefined);
  /**
   * Clear the line the act was issued on, but only while that act is still current.
   *
   * The predicate is the settlement's own, so "which draft does this clear" and
   * "whose refusal may this write" are one question answered once.
   */
  const clearSentDraft = useCallback(
    (identity: ComposerSettlementIdentity, sentDraftKey: string): void => {
      if (isCurrent(identity)) {
        draftStore.clear(sentDraftKey);
      }
    },
    [draftStore, isCurrent],
  );

  /** Write one act's settlement, or discard it because its identity has moved on. */
  const settle = useCallback(
    (identity: ComposerSettlementIdentity, settledRefusal: ConsoleRefusal | undefined): void => {
      if (!isCurrent(identity)) {
        return;
      }
      publishRefusalSlots((slots) => withSettledRefusal(slots, identity, settledRefusal));
    },
    [isCurrent, publishRefusalSlots],
  );

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
      // A refusal answers the act that produced it, so the next edit clears every slot:
      // leaving one up would make a stale refusal read as a verdict on text nobody has
      // sent. Clearing the whole record rather than the send slot alone is deliberate —
      // the person is composing again, and both acts they could have been waiting on
      // are behind them.
      publishRefusalSlots(NO_COMPOSER_REFUSALS);
    },
    [draftStore, draftKey, publishRefusalSlots],
  );

  const dispatch = useCallback(
    async (body: string) => {
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
            publishResendOffer(body);
            // THE DRAFT CLEARS ONLY WHERE THE SETTLEMENT IS STILL THE ONE ON SCREEN.
            // The draft store is keyed by ADDRESS and not by visit, so on a return
            // trip the captured key names a different draft with the same name: an
            // unconditional clear erased text the person typed on the second visit
            // to answer a send made on the first. The offer is published through
            // this visit's own holder, which drops it on the same terms.
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
    },
    [
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
      publishResendOffer,
      publishStatus,
      settle,
    ],
  );

  const send = useCallback(async () => {
    await dispatch(readDraftText());
  }, [dispatch, readDraftText]);

  const resend = useCallback(
    async (body: string) => {
      await dispatch(body);
    },
    [dispatch],
  );

  const stop = useCallback(async () => {
    const latchKey = addressedOperationKey(draftKey, visit, "stop");
    const claim = operationLatch.claim(bridge, latchKey);
    if (claim === undefined) {
      return;
    }
    publishStopping(true);
    // Stop's settlement is Stop's own: it writes the `stop` slot and clears the `stop`
    // slot, and it neither erases nor is erased by whatever the send path settled as.
    const identity = issueSettlementIdentity("stop");
    try {
      const outcome = await router.stop(target);
      settle(identity, outcome.status === "refused" ? outcome.refusal : undefined);
    } finally {
      claim.settle(() => {
        publishStopping(false);
      });
      claim.release();
    }
  }, [
    bridge,
    router,
    target,
    draftKey,
    visit,
    issueSettlementIdentity,
    operationLatch,
    publishStopping,
    settle,
  ]);

  // The window's one restart disclosure, measured against this line's own text. Its
  // own module because it is the controller's only concern that is not about an act.
  const restartDisclosure = useRestartDisclosure(draftStore, text);

  const resolution = useMemo(() => router.resolve(text, target), [router, text, target]);

  return {
    text,
    placeholder: composeDirectivePlaceholder(target),
    pathLabel: directivePathLabel(resolution),
    status,
    isStopping,
    refusal: renderableRefusal(refusalSlots),
    resendableText: resendOffer,
    restartNotice: restartDisclosure.notice,
    changeText,
    send,
    resend,
    stop,
    recallOlder,
    recallNewer,
    acknowledgeRestartNotice: restartDisclosure.acknowledge,
  };
}
