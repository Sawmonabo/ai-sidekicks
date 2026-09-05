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
// unavailable until the previous call settled, forever where it never did. Both
// halves are keyed through the holders `console/bridge/` publishes rather than
// through anything local. The console's one `GenerationLatch` holds the slot under
// `(bridge, addressedOperationKey(draftKey, operation))`, claimed before the await
// and released in `finally`, which makes a second press at the SAME address a no-op
// in the same tick and leaves another address free; `useSubjectScopedState` holds
// `status` and `isStopping` under `(bridge, draftKey)` and resets them during the
// render that first sees a new address, so the new target reads idle on its first
// frame rather than one frame later. Their dispositions for a late settlement
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
// turn while a send is in flight is exactly what the control exists for, and one
// slot per address would put Stop behind the state it escapes. A second press while
// the first is held is silent, as `dispatch`'s own is — the person pressed the
// control for the interrupt already going.
//
// THE HISTORY WALK IS PER ADDRESS FOR THE SAME REASON. One history for the life of
// the mounted bar carried an address's sent messages, and any walk in progress, into
// the next address the bar was rebound to. `AddressedDirectiveHistories` keys them
// on the same draft key, so the composer walks the history of the target it is
// addressed to and no other.
//
// THE RESEND OFFER CARRIES ITS ADDRESSING. The tripwire card offers the last sent
// body so a neutralized turn can be retried without retyping, and that body used to
// be a bare string that outlived the address it was written for: sending to one
// agent and then focusing another whose run had tripped offered the first agent's
// words, and pressing the offer sent them to the second. So the offer is held WITH
// the draft key it was sent under and is exposed only while that key is still the
// current one. The draft key is already this composer's address identity, so the
// guard is the same notion of "same target" the draft store keys on rather than a
// second one beside it.
//
// EVERY SETTLEMENT IS KEYED TO THE ACT THAT PRODUCED IT. The refusal used to be one
// hook-wide slot, and a hook-wide slot cannot say which target a refusal is about or
// which act it answers: a send to one agent that the daemon refused while the person
// re-addressed the composer wrote its refusal under the new target, and a concurrent
// success or a Stop cleared the slot the other operation's refusal was standing in.
// `send-settlement.ts` holds the identity — the address, the operation, the attempt —
// and this hook captures one at each dispatch and admits a settlement only while that
// identity is still current. A completion whose address has moved on is discarded
// where it lands rather than parked for a later render to find.
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

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { ConsoleRefusal } from "../../../console/core/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../console/store/index.js";
import { composerDraftKey } from "./draft-key.js";
import { composerRefusal } from "./send-refusals.js";
import { composeDirectivePlaceholder, directivePathLabel } from "./directive-line.js";
import { useDirectiveRecall } from "./use-directive-recall.js";
import { useRestartDisclosure } from "./use-restart-disclosure.js";
import {
  NO_COMPOSER_REFUSALS,
  addressedOperationKey,
  isSettlementCurrent,
  renderableRefusal,
  withSettledRefusal,
  type ComposerSendOperation,
  type ComposerSettlementIdentity,
} from "./send-settlement.js";
import { ComposerSendRouter } from "./send-router.js";
import { RunVersionLedger } from "./run-version-ledger.js";
import type {
  SendController,
  SendControllerDependencies,
  SendControllerStatus,
} from "./send-controller-contract.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
/**
 * What a recognised command with nowhere to run says.
 *
 * Names the state rather than the wiring: a person cannot act on "no executor was
 * supplied", and can act on knowing their text is still there and the command did
 * not run.
 */
const NO_EXECUTOR_DETAIL =
  "That command was recognised but nothing here can run it, so nothing happened. Your message is still in the line.";

/** The last sent body, held under the composer address it was sent to. */
interface AddressedResendOffer {
  readonly draftKey: string;
  readonly body: string;
}

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
  const [refusalSlots, setRefusalSlots] = useState(NO_COMPOSER_REFUSALS);
  const [resendOffer, setResendOffer] = useState<AddressedResendOffer | undefined>(undefined);

  const draftKey = composerDraftKey(target);
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
  // The address a settlement is measured against is the composer's CURRENT one, and a
  // dispatch's own closure holds the address it was ISSUED at — so the current key
  // travels through a ref that every render refreshes, and the two are compared where
  // the call lands rather than assumed to be the same.
  const currentDraftKeyRef = useRef(draftKey);
  currentDraftKeyRef.current = draftKey;
  // The attempt counter and the newest attempt of each operation. Refs rather than
  // state for the reason the single-flight latches are: both are written and read
  // inside one handler's own tick, and a state read there would see the value from
  // the render that produced the handler.
  const nextAttemptIdRef = useRef(0);
  const newestAttemptIdRef = useRef<Record<ComposerSendOperation, number>>({ send: 0, stop: 0 });

  /** Capture the identity of one act, and make it that operation's newest attempt. */
  const issueSettlementIdentity = useCallback(
    (operation: ComposerSendOperation): ComposerSettlementIdentity => {
      nextAttemptIdRef.current += 1;
      const attemptId = nextAttemptIdRef.current;
      newestAttemptIdRef.current[operation] = attemptId;
      return { draftKey: currentDraftKeyRef.current, operation, attemptId };
    },
    [],
  );

  /** Write one act's settlement, or discard it because its identity has moved on. */
  const settle = useCallback(
    (identity: ComposerSettlementIdentity, settledRefusal: ConsoleRefusal | undefined): void => {
      if (!isSettlementCurrent(identity, currentDraftKeyRef.current, newestAttemptIdRef.current)) {
        return;
      }
      setRefusalSlots((slots) => withSettledRefusal(slots, identity, settledRefusal));
    },
    [],
  );

  const subscribeToDraft = useCallback(
    (onDraftChanged: () => void) => draftStore.subscribe(draftKey, onDraftChanged),
    [draftStore, draftKey],
  );
  // Returns a plain string rather than the entry, so the snapshot is value-stable
  // across renders and `useSyncExternalStore` has nothing to loop on.
  const readDraftText = useCallback(
    () => draftStore.read(draftKey)?.text ?? "",
    [draftStore, draftKey],
  );
  const text = useSyncExternalStore(subscribeToDraft, readDraftText, readDraftText);
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
      setRefusalSlots(NO_COMPOSER_REFUSALS);
    },
    [draftStore, draftKey],
  );

  const dispatch = useCallback(
    async (body: string) => {
      // Claimed for THIS address, so a message already going to another target is no
      // reason to refuse this one. A second press at this address is silent rather
      // than refused: the person pressed Send for the message that is already going,
      // and a refusal card would report a failure where the only thing that happened
      // is that they were early.
      const latchKey = addressedOperationKey(draftKey, "send");
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
            setResendOffer({ draftKey, body });
            // Keyed to the captured address on every arm below, and deliberately so:
            // the draft that was sent is the one that clears, even when the composer
            // has since been re-addressed. Only the SETTLEMENT is discarded when the
            // address moves; the act itself happened at the address it was issued at.
            draftStore.clear(draftKey);
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
            // cleared because the act happened, and nothing was sent.
            draftStore.clear(draftKey);
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
      draftStore,
      draftKey,
      commandExecutor,
      history,
      issueSettlementIdentity,
      operationLatch,
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
    const latchKey = addressedOperationKey(draftKey, "stop");
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
    refusal: renderableRefusal(refusalSlots, draftKey),
    resendableText: resendOffer?.draftKey === draftKey ? resendOffer.body : undefined,
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
