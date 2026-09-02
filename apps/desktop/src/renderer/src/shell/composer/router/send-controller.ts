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
// THE SINGLE-FLIGHT LATCH IS A REF AND NOT THE STATUS. `status` is what the surface
// RENDERS, and a handler reading it sees the value from the render that produced
// the handler — so two Enter presses inside one frame both read `idle` and both
// dispatch, queueing two turns from one intent. The ref is set before the await and
// cleared in `finally`, which makes the second press a no-op in the same tick.
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
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { DraftStore } from "../../../console/persistence/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "./command-executor.js";
import { composerDraftKey } from "./draft-key.js";
import { composerRefusal } from "./send-refusals.js";
import {
  DirectiveHistory,
  caretAtEnd,
  caretAtStart,
  composeDirectivePlaceholder,
  directivePathLabel,
  type DirectiveCaret,
  type DirectivePathLabel,
} from "./directive-line.js";
import {
  ComposerSendRouter,
  type ClientCommandPredicate,
  type ProviderCommandPredicate,
} from "./send-router.js";

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
  /** The last refusal, composer-side or daemon-side, until the person types again. */
  readonly refusal: ConsoleRefusal | undefined;
  /** The most recent sent message, so a tripped run can be resent without retyping. */
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
  const router = useMemo(
    () =>
      new ComposerSendRouter({
        bridge,
        ...(recognizeClientCommand === undefined ? {} : { recognizeClientCommand }),
        ...(recognizeProviderCommand === undefined ? {} : { recognizeProviderCommand }),
      }),
    [bridge, recognizeClientCommand, recognizeProviderCommand],
  );
  // A ref rather than state: the walk's own cursor is not rendered, and putting it
  // in state would re-render the whole bar on a keystroke that changed nothing a
  // person can see.
  const historyRef = useRef<DirectiveHistory>(new DirectiveHistory());
  // Set before the await and cleared in `finally`, so every settlement — sent,
  // intercepted, refused, or a rejection the router turned into a refusal — releases
  // it on exactly one path rather than on the arms an author remembered.
  const isDispatchInFlight = useRef(false);
  const [status, setStatus] = useState<SendControllerStatus>("idle");
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const [resendableText, setResendableText] = useState<string | undefined>(undefined);
  // Armed by the first focus of this composer, and only where the store still owed
  // the disclosure. The store stays the source of whether one is owed at all; this
  // hook decides nothing except when the sentence has something to be about.
  const [isRestartNoticeArmed, setRestartNoticeArmed] = useState(false);

  const draftKey = composerDraftKey(target);
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

  const changeText = useCallback(
    (next: string) => {
      draftStore.write(draftKey, next);
      // A refusal answers the act that produced it, so the next edit clears it: leaving
      // it up would make a stale refusal read as a verdict on text nobody has sent.
      setRefusal(undefined);
    },
    [draftStore, draftKey],
  );

  const dispatch = useCallback(
    async (body: string) => {
      if (isDispatchInFlight.current) {
        // Silent rather than refused: the person pressed Send for the message that
        // is already going, and a refusal card would report a failure where the
        // only thing that happened is that they were early.
        return;
      }
      isDispatchInFlight.current = true;
      setStatus("sending");
      try {
        const outcome = await router.send(body, target);
        switch (outcome.status) {
          case "sent":
            historyRef.current.recordSent(body);
            setResendableText(body);
            draftStore.clear(draftKey);
            setRefusal(undefined);
            return;
          case "intercepted": {
            if (commandExecutor === undefined) {
              setRefusal(composerRefusal("command-unexecutable", NO_EXECUTOR_DETAIL));
              return;
            }
            const settled = await commandExecutor({
              commandName: outcome.commandName,
              text: body.trim(),
            });
            if (settled.status === "refused") {
              // The line is kept: the command did not run, and the text is the one
              // thing the person would otherwise have to retype to try again.
              setRefusal(settled.refusal);
              return;
            }
            // A registered command never composes into a message: the line is
            // cleared because the act happened, and nothing was sent.
            draftStore.clear(draftKey);
            setRefusal(undefined);
            return;
          }
          case "refused":
            setRefusal(outcome.refusal);
            return;
        }
      } finally {
        isDispatchInFlight.current = false;
        setStatus("idle");
      }
    },
    [router, target, draftStore, draftKey, commandExecutor],
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
    const outcome = await router.stop(target);
    setRefusal(outcome.status === "refused" ? outcome.refusal : undefined);
  }, [router, target]);

  const recallOlder = useCallback(
    (caret: DirectiveCaret) => {
      if (!caretAtStart(caret)) {
        return false;
      }
      const recalled = historyRef.current.recallOlder(readDraftText());
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey, readDraftText],
  );

  const recallNewer = useCallback(
    (caret: DirectiveCaret) => {
      if (!caretAtEnd(caret)) {
        return false;
      }
      const recalled = historyRef.current.recallNewer();
      if (recalled === undefined) {
        return false;
      }
      draftStore.write(draftKey, recalled);
      return true;
    },
    [draftStore, draftKey],
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
    refusal,
    resendableText,
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
