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

import { useCallback, useMemo, useRef, useState } from "react";

import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import {
  DirectiveHistory,
  caretAtEnd,
  caretAtStart,
  composeDirectivePlaceholder,
  directivePathLabel,
  type DirectiveCaret,
  type DirectivePathLabel,
} from "./directive-line.js";
import { ComposerSendRouter } from "./send-router.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

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
  changeText(next: string): void;
  send(): Promise<void>;
  /** Send one exact body again. The tripwire card's offer; never a silent retry. */
  resend(body: string): Promise<void>;
  stop(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DirectiveCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DirectiveCaret): boolean;
}

/** Build the controller for one addressed composer. */
export function useSendController(bridge: ConsoleBridge, target: ComposerTarget): SendController {
  const router = useMemo(() => new ComposerSendRouter({ bridge }), [bridge]);
  // A ref rather than state: the walk's own cursor is not rendered, and putting it
  // in state would re-render the whole bar on a keystroke that changed nothing a
  // person can see.
  const historyRef = useRef<DirectiveHistory>(new DirectiveHistory());
  const [text, setText] = useState("");
  const [status, setStatus] = useState<SendControllerStatus>("idle");
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const [resendableText, setResendableText] = useState<string | undefined>(undefined);

  const changeText = useCallback((next: string) => {
    setText(next);
    // A refusal answers the act that produced it, so the next edit clears it: leaving
    // it up would make a stale refusal read as a verdict on text nobody has sent.
    setRefusal(undefined);
  }, []);

  const dispatch = useCallback(
    async (body: string) => {
      setStatus("sending");
      try {
        const outcome = await router.send(body, target);
        switch (outcome.status) {
          case "sent":
            historyRef.current.recordSent(body);
            setResendableText(body);
            setText("");
            setRefusal(undefined);
            return;
          case "intercepted":
            // A registered command never composes into a message: the line is
            // cleared because the act happened, and nothing was sent.
            setText("");
            setRefusal(undefined);
            return;
          case "refused":
            setRefusal(outcome.refusal);
            return;
        }
      } finally {
        setStatus("idle");
      }
    },
    [router, target],
  );

  const send = useCallback(async () => {
    await dispatch(text);
  }, [dispatch, text]);

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
      const recalled = historyRef.current.recallOlder(text);
      if (recalled === undefined) {
        return false;
      }
      setText(recalled);
      return true;
    },
    [text],
  );

  const recallNewer = useCallback((caret: DirectiveCaret) => {
    if (!caretAtEnd(caret)) {
      return false;
    }
    const recalled = historyRef.current.recallNewer();
    if (recalled === undefined) {
      return false;
    }
    setText(recalled);
    return true;
  }, []);

  const resolution = useMemo(() => router.resolve(text, target), [router, text, target]);

  return {
    text,
    placeholder: composeDirectivePlaceholder(target),
    pathLabel: directivePathLabel(resolution),
    status,
    refusal,
    resendableText,
    changeText,
    send,
    resend,
    stop,
    recallOlder,
    recallNewer,
  };
}
