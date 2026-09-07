// What keeps the window's shell state live, and the two producers that fill it.
//
// The state itself lives on the frame store (`store/shell-state.ts` owns the
// vocabulary), because the palette, the sessions surfaces, and the settings daemon
// page all read it and they sit on three different levels of the console DAG. This
// module owns the one thing a store cannot own: the lifetimes that fill it.
//
// TWO PRODUCERS, ONE VALUE, AND NEITHER IS A TIMER.
//
//   • The shell's own report — supervisor state, the handshake, the transport, and
//     the keystore — arrives over a subscription the main process pushes. No wire
//     carries it yet, so it goes through the growth port and its slate row; the live
//     bridge refuses it by name and the window stays honestly unreported.
//   • The recovery cause is folded from the session stores this window already
//     holds. It is not the shell's to report: a gap is something THIS window's
//     subscription noticed, and asking the shell about it would be asking the wrong
//     process.
//
// `Spec-023 §Console Design (Meridian)` forbids interval polling outright, and there
// is nothing to poll here: one push subscription and one store subscription.
//
// A DROPPED STREAM PUBLISHES `unreported` RATHER THAN THE LAST THING IT HEARD. A
// report is a claim about right now; holding the last one after the channel closed
// would leave a window saying "connected" on the strength of a message that arrived
// before the process carrying it went away.

import { useCallback, useEffect } from "react";

import { useConsoleBridge } from "../../bridge/index.js";
import type { GrowthPort } from "../../bridge/index.js";
import {
  UNREPORTED_SHELL_STATE,
  useWorstOpenSessionRecovery,
  type FrameStore,
  type SessionStoreRegistry,
  type ShellReport,
} from "../../store/index.js";

/**
 * Keep this window's shell state live for as long as the frame is mounted.
 *
 * One hook rather than two, because the two producers write one value and a caller
 * that could mount half of it would be a window rendering a supervisor state with no
 * recovery line, or the reverse.
 */
export function useShellStateBinding(
  frameStore: FrameStore,
  sessionStoreRegistry: SessionStoreRegistry,
): void {
  const bridge = useConsoleBridge();
  useShellReportSubscription(frameStore, bridge.growth);

  // Folded through the store family's own hook, which compares the folded cause
  // rather than the stores, so an ordinary event batch re-renders nothing here.
  const sessionRecovery = useWorstOpenSessionRecovery(sessionStoreRegistry);
  useEffect(() => {
    frameStore.publishSessionRecovery(sessionRecovery);
  }, [frameStore, sessionRecovery]);
}

/**
 * Drain the shell's report stream into the frame store until the frame unmounts.
 *
 * The drain is a `for await` over the stream's own iterable rather than a callback
 * registration, which is the shape the growth port publishes and the shape that makes
 * the four ways this ends — the stream ending, the stream throwing, the effect being
 * cleaned up, and the port refusing before a stream exists — four ordinary control
 * paths rather than four listeners to remember to remove.
 */
function useShellReportSubscription(frameStore: FrameStore, growth: GrowthPort): void {
  useEffect(() => {
    let released = false;
    let stream: { close(): void } | undefined;

    const drain = async (): Promise<void> => {
      const outcome = await growth.shellStatusSubscribe({});
      if (outcome.status !== "served") {
        // The build does not carry the wire. `unreported` is already the store's
        // seeded value, so there is nothing to write and nothing to say: the chip
        // renders the absence and no control is disabled on the strength of it.
        return;
      }
      if (released) {
        outcome.value.close();
        return;
      }
      stream = outcome.value;
      try {
        for await (const report of outcome.value.events) {
          if (released) {
            return;
          }
          frameStore.publishShellReport(report);
        }
      } finally {
        if (!released) {
          // The channel went away while this window was still watching it. What it
          // last said is no longer a claim about now.
          frameStore.publishShellReport(unreportedShellReport());
        }
      }
    };

    void drain();

    return () => {
      released = true;
      stream?.close();
    };
  }, [frameStore, growth]);
}

/**
 * The manual retry, offered once the supervisor's ladder is spent.
 *
 * A SPAWN AND NOT A CALL, which is why it goes through the growth port rather than
 * the daemon client: a stopped runtime has no server to receive a start, so the act
 * belongs to the shell. Nothing here reports success — the supervisor's next report
 * is what says whether it came back, and a control that painted "connected" because
 * its own call resolved would be synthesizing the one state this plane may never
 * synthesize.
 *
 * WHICH IS ALSO WHY THE SHELL'S MUTATION BLOCK NEVER REACHES IT. Every daemon-bound
 * write is closed while the supervisor is reconnecting, incompatible, offline, or
 * stopped — `store/shell-state.ts` owns that rule and the sessions destination applies
 * it to the acts it offers — and the daemon's OWN lifecycle controls, this retry and
 * the stop and restart on its settings page, are the exception by construction rather
 * than by exemption: they are not on `MUTATING_DAEMON_METHODS` because they are not
 * daemon methods at all. A rule that blocked them would leave a stopped runtime with
 * no way back, which is the one state a person most needs a control for.
 *
 * A refusal is raised on the frame's own banner stack, because a control that is
 * pressed and answers with silence is indistinguishable from one that is broken.
 */
export function useDaemonStartAction(frameStore: FrameStore): () => void {
  const bridge = useConsoleBridge();
  return useCallback(() => {
    void (async () => {
      const outcome = await bridge.growth.daemonStart({});
      if (outcome.status !== "served") {
        frameStore.raiseRefusalBanner(outcome);
      }
    })();
  }, [bridge, frameStore]);
}

/** The report half of the seeded state, so "nothing is reported" has one spelling. */
function unreportedShellReport(): ShellReport {
  const { connection, negotiation, lastHeartbeatAt, transport, keystore } = UNREPORTED_SHELL_STATE;
  return { connection, negotiation, lastHeartbeatAt, transport, keystore };
}
