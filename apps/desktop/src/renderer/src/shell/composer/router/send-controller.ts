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
// through anything local. `BridgeScopedLatch` holds the in-flight slot under
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
import {
  BridgeScopedLatch,
  useSubjectScopedState,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "./command-executor.js";
import { composerDraftKey } from "./draft-key.js";
import { composerRefusal } from "./send-refusals.js";
import {
  AddressedDirectiveHistories,
  caretAtEnd,
  caretAtStart,
  composeDirectivePlaceholder,
  directivePathLabel,
  type DirectiveCaret,
  type DirectivePathLabel,
} from "./directive-line.js";
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
import type { ClientCommandPredicate, ProviderCommandPredicate } from "./send-resolutions.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

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

/** What the composer is built from. One object, so a new dependency is one edit. */
export interface SendControllerDependencies {
  readonly bridge: ConsoleBridge;
  readonly target: ComposerTarget;
  /** The window-lifetime draft store the composer seat is handed. */
  readonly draftStore: DraftStore;
  /**
   * Whether a name is a registered client command.
   *
   * Travels with the executor because the two are one decision split in half: the
   * router will not intercept a name nothing claims, so a recogniser without an
   * executor intercepts into a refusal and an executor without a recogniser is
   * never called. The composer's command zone supplies both or neither.
   */
  readonly recognizeClientCommand?: ClientCommandPredicate | undefined;
  /**
   * Whether a name is one the bound provider published, for discovery only.
   *
   * Supplied by the same zone and read off the same holder the discovery popover
   * renders from, so a name the list showed and a name the send path recognises are
   * one reading. Absent, a typed provider command refuses exactly as it did before
   * the two zones shared one.
   */
  readonly recognizeProviderCommand?: ProviderCommandPredicate | undefined;
  /**
   * Runs a recognised client command, when this composer has one to run with.
   *
   * Optional because the command family is a separate zone that mounts its own
   * recogniser and executor together. Absent, an intercepted line REFUSES: the
   * router only intercepts a name a recogniser claimed, so reaching this arm with
   * no executor means the two halves were wired apart, and clearing the line would
   * report success for an act nothing performed.
   */
  readonly commandExecutor?: CommandExecutor | undefined;
}

/** Everything the send bar renders and every act it offers. */
export interface SendController {
  readonly text: string;
  readonly placeholder: string;
  /** "new turn" or "steer", or `undefined` when this text resolves to no send. */
  readonly pathLabel: DirectivePathLabel | undefined;
  readonly status: SendControllerStatus;
  /**
   * Whether an interrupt is in flight, so the surface can mark Stop busy.
   *
   * Its own reading rather than a second value of {@link status}: a stop and a send
   * can be in flight at once, and one status could not say so.
   */
  readonly isStopping: boolean;
  /** The last refusal, composer-side or daemon-side, until the person types again. */
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * The most recent message sent to THIS address, so a tripped run can be resent
   * without retyping. `undefined` once the composer is re-addressed, because a body
   * written for one target is not an offer to send it to another.
   */
  readonly resendableText: string | undefined;
  /**
   * The store's restart disclosure, while it is armed and there is text to lose.
   *
   * The sentence is the store's own — fixed text carrying no participant content —
   * so the composer renders what the store says rather than a second wording of it.
   */
  readonly restartNotice: string | undefined;
  changeText(next: string): void;
  send(): Promise<void>;
  /** Send one exact body again. The tripwire card's offer; never a silent retry. */
  resend(body: string): Promise<void>;
  stop(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DirectiveCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DirectiveCaret): boolean;
  /** Called when the line takes focus, which is what arms the disclosure. */
  acknowledgeRestartNotice(): void;
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
  // A ref rather than state: the walk's own cursor is not rendered, and putting it
  // in state would re-render the whole bar on a keystroke that changed nothing a
  // person can see.
  const historiesRef = useRef<AddressedDirectiveHistories>(new AddressedDirectiveHistories());
  // Claimed before the await and released in `finally`, so every settlement — sent,
  // intercepted, refused, or a rejection the router turned into a refusal — releases
  // the slot on exactly one path rather than on the arms an author remembered. A
  // `useState` initializer rather than a `useMemo`, on `approvals-hooks.ts`'s
  // reasoning: a latch React was free to rebuild would forget an act still going.
  const [operationLatch] = useState(() => new BridgeScopedLatch());
  const [refusalSlots, setRefusalSlots] = useState(NO_COMPOSER_REFUSALS);
  const [resendOffer, setResendOffer] = useState<AddressedResendOffer | undefined>(undefined);
  // Armed by the first focus of this composer, and only where the store still owed
  // the disclosure. The store stays the source of whether one is owed at all; this
  // hook decides nothing except when the sentence has something to be about.
  const [isRestartNoticeArmed, setRestartNoticeArmed] = useState(false);

  const draftKey = composerDraftKey(target);
  // What the bar renders while an act is travelling, held under the address that act
  // was issued at. Two holders rather than one object: a send and a Stop can be in
  // flight at once, and one publisher writing a pair would let whichever settled
  // second overwrite what the other had just said.
  const [status, publishStatus] = useSubjectScopedState<SendControllerStatus>(
    bridge,
    draftKey,
    "idle",
  );
  const [isStopping, publishStopping] = useSubjectScopedState(bridge, draftKey, false);
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
  // Asked on every pass rather than in an effect, so a keystroke arriving before an
  // effect could run still walks this address's own history. Idempotent for an
  // address already current, which is what makes asking here safe.
  const history = historiesRef.current.forAddress(draftKey);

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
      if (!operationLatch.claim(bridge, latchKey)) {
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
        // The slot released is the one this act claimed, which is what lets a
        // settlement arriving after a re-address free the address it was issued at
        // rather than the one on screen. The reading is published through this
        // address's own publisher, so it lands only while that address is current.
        operationLatch.release(bridge, latchKey);
        publishStatus("idle");
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
    if (!operationLatch.claim(bridge, latchKey)) {
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
      operationLatch.release(bridge, latchKey);
      publishStopping(false);
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

  const recallOlder = useCallback(
    (caret: DirectiveCaret) => {
      if (!caretAtStart(caret)) {
        return false;
      }
      const recalled = history.recallOlder(readDraftText());
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey, readDraftText, history],
  );

  const recallNewer = useCallback(
    (caret: DirectiveCaret) => {
      if (!caretAtEnd(caret)) {
        return false;
      }
      const recalled = history.recallNewer();
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey, history],
  );

  const acknowledgeRestartNotice = useCallback(() => {
    if (!draftStore.restartNoticePending) {
      // Already told, in this composer or in another one this window holds. A second
      // arming would be the window saying it twice.
      return;
    }
    draftStore.acknowledgeRestartNotice();
    setRestartNoticeArmed(true);
  }, [draftStore]);

  const resolution = useMemo(() => router.resolve(text, target), [router, text, target]);

  return {
    text,
    placeholder: composeDirectivePlaceholder(target),
    pathLabel: directivePathLabel(resolution),
    status,
    isStopping,
    refusal: renderableRefusal(refusalSlots, draftKey),
    resendableText: resendOffer?.draftKey === draftKey ? resendOffer.body : undefined,
    restartNotice:
      isRestartNoticeArmed && text.length > 0 ? draftStore.restartNoticeText : undefined,
    changeText,
    send,
    resend,
    stop,
    recallOlder,
    recallNewer,
    acknowledgeRestartNotice,
  };
}
