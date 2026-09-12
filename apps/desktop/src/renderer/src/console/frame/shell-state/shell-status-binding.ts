// What keeps the window's shell state live, and the two producers that fill it.
//
// The state itself lives on the frame store (`store/shell/shell-state.ts` owns the
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
// Interval polling is forbidden outright, and there is nothing to poll here: one push
// subscription and one store subscription.
//
// A DROPPED STREAM PUBLISHES `unreported` RATHER THAN THE LAST THING IT HEARD. A
// report is a claim about right now; holding the last one after the channel closed
// would leave a window saying "connected" on the strength of a message that arrived
// before the process carrying it went away.
//
// AND SO DOES A NEW SUBSCRIPTION, BEFORE ITS OUTCOME. The same sentence read from the
// other end: a report is a claim one supervisor made, so a window addressed at a
// DIFFERENT one is holding a claim nobody is making about it. That is not a hypothesis
// — a bridge is replaced when the fixture's scenario switches and when a window
// re-pairs, and the replacement's first act is a subscribe that may be refused
// outright, which publishes nothing at all. Clearing on the way OUT would not reach it
// either: the drain that was torn down must not write over what its successor has
// already said, so its own settlement is refused, and there is nothing left to clear
// the value. So the reset is the first thing the new subscription does.

import { useCallback, useEffect, useLayoutEffect } from "react";

import { settleGrowthRead, useConsoleBridge } from "../../bridge/index.js";
import type { ConsoleBridge, GrowthPort } from "../../bridge/index.js";
import {
  UNREPORTED_SHELL_STATE,
  useGenerationLatch,
  useWorstOpenSessionRecovery,
  type FrameStore,
  type SessionStoreRegistry,
  type ShellReport,
} from "../../store/index.js";

/**
 * The one act this binding has in flight per port: draining that port's report stream.
 *
 * A key inside the port's own key space rather than an identity, per
 * `store/read/generation-latch.ts`: one port carries one shell, so one drain.
 */
const SHELL_REPORT_DRAIN_KEY = "shell-report-drain";

/**
 * The other act this binding puts per port: asking the shell to start the daemon.
 *
 * A SECOND KEY AND NOT THE DRAIN'S, because the two acts are unrelated — a report
 * stream is running for the life of the frame and a start is a one-shot — and sharing
 * one key would make the drain's claim refuse every retry ever offered.
 */
const DAEMON_START_KEY = "daemon-start";

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
  useShellConditionGateBinding(frameStore, bridge);
  useShellReportSubscription(frameStore, bridge.growth);

  // Folded through the store family's own hook, which compares the folded cause
  // rather than the stores, so an ordinary event batch re-renders nothing here.
  const sessionRecovery = useWorstOpenSessionRecovery(sessionStoreRegistry);
  useEffect(() => {
    frameStore.publishSessionRecovery(sessionRecovery);
  }, [frameStore, sessionRecovery]);
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
 * stopped — `store/shell/shell-state.ts` owns that rule and the sessions destination applies
 * it to the acts it offers — and the daemon's OWN lifecycle controls, this retry and
 * the stop and restart on its settings page, are the exception by construction rather
 * than by exemption: they are not on `MUTATING_DAEMON_METHODS` because they are not
 * daemon methods at all. A rule that blocked them would leave a stopped runtime with
 * no way back, which is the one state a person most needs a control for.
 *
 * A refusal is raised on the frame's own banner stack, because a control that is
 * pressed and answers with silence is indistinguishable from one that is broken.
 *
 * AND ONE SPAWN AT A TIME, DECIDED IN THE TICK. Nothing here renders a disabled state
 * — the retry sits on a banner whose own presence is the affordance — so there was no
 * flag to read and nothing at all between a double-click and two concurrent spawns of
 * the same runtime. The supervisor's next report is what eventually says `starting`,
 * and it arrives over a subscription several frames after the press: every click
 * inside that window used to reach the shell. The key is taken synchronously before
 * the call goes out and given back in the `finally`, so a retry that REFUSES leaves
 * the control working — the failure `settings/pages/daemon/daemon-controls.ts` records
 * having shipped once, where a rejection awaited outside the release left a
 * destructive control dead for the life of the window.
 *
 * The subject is the PORT, exactly as the drain above: a port is minted once per
 * bridge and its replacement is what retires the calls made through it. The latch is
 * mount-scoped, so a reply arriving after the frame is gone raises no banner into a
 * tree that no longer exists.
 */
export function useDaemonStartAction(frameStore: FrameStore): () => void {
  const bridge = useConsoleBridge();
  const spawns = useGenerationLatch();
  return useCallback(() => {
    const { growth } = bridge;
    const spawn = spawns.claim(growth, DAEMON_START_KEY);
    if (spawn === undefined) {
      return;
    }
    void (async () => {
      try {
        // Through the console's one settler rather than a bare `await`, on the
        // local-runtime page's own terms: the port is TYPED to resolve, and the
        // rejection channel of a promise exists whether a contract uses it or not. Read
        // only on the fulfilment arm, a transport that went away mid-spawn escaped this
        // detached body as an unhandled rejection and raised no banner at all — the
        // silence this function's own header calls indistinguishable from broken.
        const outcome = await settleGrowthRead(growth.daemonStart({}));
        spawn.settle(() => {
          if (outcome.status !== "served") {
            frameStore.raiseRefusalBanner(outcome);
          }
        });
      } finally {
        spawn.release();
      }
    })();
  }, [bridge, frameStore, spawns]);
}

/**
 * Hand the window's store to the bridge's gate, so the CALL DOOR can read the
 * condition this module fills.
 *
 * THE THIRD READER OF ONE VALUE, and the reason it is wired here rather than at the
 * door. `bridge/daemon/daemon-reply.ts` refuses a record dispatch while the
 * supervisor is not serving, and it is handed only a `ConsoleBridge` — the frame
 * store is born in the frame composition with the bridge already a prop, so the
 * binding has to come from the side that owns both. This hook owns both, and it is
 * already the module that fills the value.
 *
 * A LAYOUT EFFECT AND NOT AN EFFECT, because a dispatch can be put from a mount
 * effect in the same commit: a passive effect ordered after those would leave the
 * first window's opening calls reading an unbound gate. The release names the store
 * it bound, so a remount that binds the successor before the predecessor's cleanup
 * runs does not clear the live binding.
 */
function useShellConditionGateBinding(frameStore: FrameStore, bridge: ConsoleBridge): void {
  const { shellCondition } = bridge;
  useLayoutEffect(() => {
    shellCondition.bindFrameStore(frameStore);
    return () => {
      shellCondition.releaseFrameStore(frameStore);
    };
  }, [frameStore, shellCondition]);
}

/**
 * Drain the shell's report stream into the frame store until the frame unmounts.
 *
 * The drain is a `for await` over the stream's own iterable rather than a callback
 * registration, which is the shape the growth port publishes and the shape that makes
 * the four ways this ends — the stream ending, the stream throwing, the effect being
 * cleaned up, and the port refusing before a stream exists — four ordinary control
 * paths rather than four listeners to remember to remove.
 *
 * AND ALL FOUR ARE ORDINARY, THE THROW INCLUDED. A subscription that is torn down
 * mid-flight, or a frame that will not decode, REJECTS the iterator rather than ending
 * it — and the SUBSCRIBE itself rejects the same way where the transport goes away
 * before a stream exists at all, which is why acquisition is inside the guard and not
 * above it. This drain's promise is discarded, so an escaping rejection is not a
 * failure anybody sees but an unhandled rejection in the renderer. It is caught here
 * and settled as what it actually is: the channel going away, which is the same
 * reading a clean end publishes, because a report is a claim about right now either
 * way. The stream goes with it, since a producer that threw part-way is still a
 * subscription somebody has to end.
 *
 * WHICH DRAIN MAY WRITE IS THE CONSOLE'S ONE LATCH, KEYED ON THE PORT. Every write
 * below — each frame, and the channel-loss reading in the `finally` — goes through a
 * claim taken when the subscription starts, so a drain whose port has been replaced
 * settles NOWHERE rather than over what its successor has already published. A local
 * boolean said the same thing in this one module and was the seventh copy of the guard
 * `store/read/generation-latch.ts` owns, which is the shape that drifts: it read a teardown
 * and could not read a re-address, and it went stale in a different place from every
 * other copy of it. The subject is the PORT, because a port is minted once per bridge
 * and its replacement is exactly what retires the calls made through it.
 */
function useShellReportSubscription(frameStore: FrameStore, growth: GrowthPort): void {
  const drains = useGenerationLatch();
  useEffect(() => {
    // BEFORE THE OUTCOME, AND DELIBERATELY NOT AFTER IT. What the previous port said
    // is not a claim about this one, and the two paths that would otherwise clear it
    // both fail to: a refused subscribe publishes nothing at all, and the retired
    // drain's own settlement is refused by the claim below.
    frameStore.publishShellReport(unreportedShellReport());
    const drainClaim = drains.supersedeAndClaim(growth, SHELL_REPORT_DRAIN_KEY);
    let stream: { close(): void } | undefined;
    /** Close the acquired stream at most once, from whichever path reaches it first. */
    const closeStream = (): void => {
      const acquired = stream;
      stream = undefined;
      acquired?.close();
    };

    const drain = async (): Promise<void> => {
      try {
        // ACQUISITION IS INSIDE THE GUARD, NOT AHEAD OF IT, and through the console's
        // one settler rather than a bare `await`. Awaited above the `try`, a subscribe
        // that REJECTED — the transport going away while the subscription is being set
        // up — escaped this discarded drain as an unhandled rejection, with nothing
        // left to close the attempt or settle it: the iterator's own guard covers the
        // frames and covers none of the acquisition. Settled, that rejection arrives
        // as the same non-served outcome a build with no wire answers with, so one arm
        // reads both, and any throw the loop or the handle raises still lands on the
        // channel-loss reading below rather than on the host's rejection sink.
        const outcome = await settleGrowthRead(growth.shellStatusSubscribe({}));
        if (outcome.status !== "served") {
          // The build does not carry the wire, or the channel went away before it
          // could be read. The reset above already said so, and the `finally` below
          // says it again through the claim: the chip renders the absence and no
          // control is disabled on the strength of it.
          return;
        }
        if (!drainClaim.isCurrent) {
          outcome.value.close();
          return;
        }
        stream = outcome.value;
        for await (const report of outcome.value.events) {
          if (!drainClaim.settle(() => frameStore.publishShellReport(report))) {
            return;
          }
        }
      } catch {
        // The channel BROKE rather than ended, and the difference is not one this
        // window can act on: either way it is no longer being told anything. The
        // handle goes here because nothing else will reach it — the loop is over, and
        // the reading below is the same one a clean end publishes.
        closeStream();
      } finally {
        // The channel went away while this window was still watching it. What it last
        // said is no longer a claim about now — and where the port itself is what went
        // away, the claim refuses this and the successor's own reset stands.
        drainClaim.settle(() => frameStore.publishShellReport(unreportedShellReport()));
      }
    };

    void drain();

    return () => {
      drainClaim.release();
      closeStream();
    };
  }, [drains, frameStore, growth]);
}

/** The report half of the seeded state, so "nothing is reported" has one spelling. */
function unreportedShellReport(): ShellReport {
  const { connection, negotiation, lastHeartbeatAt, transport, keystore } = UNREPORTED_SHELL_STATE;
  return { connection, negotiation, lastHeartbeatAt, transport, keystore };
}
