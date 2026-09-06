// What fills the indicator registry: one read of the session's live activity, folded
// in whenever the Awareness room changes.
//
// THE REGISTRY WAS COMPLETE AND UNFED. `activity-model.ts` has held both mechanisms
// since it was written — the receiver-timed human indicator and the edge-cleared
// agent one — and nothing called either `noteComposing` or `noteAgentActivity`, so
// every indicator surface in the console rendered its empty state permanently and
// looked correct doing it. This is the producer, and it is deliberately the ONLY one:
// two writers into one registry would be two answers to who is composing where.
//
// IT IS A READ AND A SIGNAL, NOT A STREAM. `presence.subscribe` is the Awareness
// change signal and it carries no payload this module opens; the reading comes from
// the growth port's `presenceActivityRead`, which stands in for the daemon presence
// handler surface Plan-002 T3.5 ships. Both `activity.typing` and `activity.runs`
// ride that one room, so one signal covers both fields and a second subscription
// keyed to the run stream would be a second mechanism reporting one fact.
//
// THE FOLD IS A DIFF, AND THE DIFF IS WHAT MAKES THE TWO MECHANISMS SURVIVE IT.
// Applying a whole reading blindly would call `noteComposing` on every push, and
// `noteComposing` RE-ARMS the receiver's clear — so an unchanged reading, which is
// the same publication being read a second time, would keep an indicator alive
// forever off a field nobody had refreshed. That is precisely the failure the
// receiver-timed bound exists to prevent, reintroduced by its own consumer. So a
// composing reading is applied only where it is new or its `since` has MOVED, which
// is what a publisher refreshing actually looks like on the wire; and a reading that
// left the snapshot is cleared, which for an agent run is that run's own end edge as
// its publisher saw it.
//
// A FAILED READ CLEARS EVERYTHING THIS FEED APPLIED. Composing entries would expire
// on their own, but an agent entry has no deadline at all — it leaves by an edge —
// so a read that stops answering would otherwise leave a run rendered as working for
// the life of the window. Nothing this console cannot currently confirm stays on
// screen.

import {
  type ConsoleBridge,
  type GrowthActivitySnapshot,
  type GrowthAgentActivityReading,
  type GrowthComposingReading,
} from "../bridge/index.js";
import type { ConsoleClock, Unsubscribe } from "../core/index.js";
import { PushDrivenRead, servedGrowthValueOrRaise, subscribeDaemonEvent } from "../seats/index.js";
import type { SessionStore } from "../store/index.js";
import type { ActivityIndicatorRegistry } from "./activity-model.js";
import { PRESENCE_SUBSCRIBE_EVENT } from "./members/presence-model.js";

/** The refusal origin every activity-read failure carries. */
export const ACTIVITY_FEED_ORIGIN = "activity-feed";

/**
 * The session's activity, read and folded into one registry.
 *
 * A class with private fields: it owns a subscription to its own read, the applied
 * set it diffs against, and therefore a teardown. Constructed by the collaboration
 * holder and started by it, exactly as the roster and the directory are.
 */
export class ActivityFeed {
  readonly #read: PushDrivenRead<GrowthActivitySnapshot>;
  readonly #registry: ActivityIndicatorRegistry;
  readonly #appliedComposing = new Map<string, GrowthComposingReading>();
  readonly #appliedAgentRuns = new Map<string, GrowthAgentActivityReading>();
  #unsubscribe: Unsubscribe | undefined;
  #isDisposed = false;

  public constructor(
    read: PushDrivenRead<GrowthActivitySnapshot>,
    registry: ActivityIndicatorRegistry,
  ) {
    this.#read = read;
    this.#registry = registry;
  }

  /** The read itself, so a surface can render the refusal that stopped the feed. */
  public get read(): PushDrivenRead<GrowthActivitySnapshot> {
    return this.#read;
  }

  /**
   * Start listening, then start the read.
   *
   * In that order for the reason the read itself subscribes before reading: a
   * settlement that landed between `start()` and the listener attaching would be a
   * reading the registry never saw, and the next one might not arrive for minutes.
   */
  public start(): void {
    if (this.#isDisposed || this.#unsubscribe !== undefined) {
      return;
    }
    this.#unsubscribe = this.#read.onChange(() => {
      this.#applyCurrentState();
    });
    this.#read.start();
    this.#applyCurrentState();
  }

  /** Release the listener and the read. Terminal; the registry is the holder's. */
  public dispose(): void {
    this.#isDisposed = true;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    unsubscribe?.();
    this.#read.dispose();
    this.#appliedComposing.clear();
    this.#appliedAgentRuns.clear();
  }

  /** Fold whatever the read is showing now. The one entry point from the signal. */
  #applyCurrentState(): void {
    if (this.#isDisposed) {
      return;
    }
    const state = this.#read.state;
    if (state.kind === "loaded") {
      this.#apply(state.value);
      return;
    }
    if (state.kind === "failed") {
      this.#clearApplied();
    }
    // `not-loaded` holds what is already applied rather than clearing it: the read
    // enters that arm on an open that succeeded after a refusal, where nothing has
    // arrived behind the new subscription yet — and blanking every indicator to
    // re-draw the same ones a moment later is the flicker the read's own rule 5
    // forbids one layer down.
  }

  #apply(snapshot: GrowthActivitySnapshot): void {
    for (const reading of snapshot.composing) {
      const applied = this.#appliedComposing.get(reading.participantId);
      if (applied?.channelId === reading.channelId && applied.since === reading.since) {
        continue;
      }
      this.#appliedComposing.set(reading.participantId, reading);
      this.#registry.noteComposing(reading);
    }
    for (const participantId of departedKeys(
      this.#appliedComposing,
      snapshot.composing.map((reading) => reading.participantId),
    )) {
      this.#appliedComposing.delete(participantId);
      this.#registry.clearComposing(participantId);
    }
    for (const reading of snapshot.agentRuns) {
      const applied = this.#appliedAgentRuns.get(reading.runId);
      if (applied?.channelId === reading.channelId && applied.since === reading.since) {
        continue;
      }
      this.#appliedAgentRuns.set(reading.runId, reading);
      this.#registry.noteAgentActivity(reading);
    }
    for (const runId of departedKeys(
      this.#appliedAgentRuns,
      snapshot.agentRuns.map((reading) => reading.runId),
    )) {
      this.#appliedAgentRuns.delete(runId);
      this.#registry.clearAgentActivity(runId);
    }
  }

  #clearApplied(): void {
    for (const participantId of [...this.#appliedComposing.keys()]) {
      this.#registry.clearComposing(participantId);
    }
    for (const runId of [...this.#appliedAgentRuns.keys()]) {
      this.#registry.clearAgentActivity(runId);
    }
    this.#appliedComposing.clear();
    this.#appliedAgentRuns.clear();
  }
}

/**
 * The applied keys the newest reading no longer names.
 *
 * Collected before anything is deleted, because both callers iterate the applied map
 * while removing from it — and one helper rather than the same walk written twice,
 * since the composing side and the agent side ask exactly one question.
 */
function departedKeys<TValue>(
  applied: ReadonlyMap<string, TValue>,
  present: readonly string[],
): readonly string[] {
  const presentKeys = new Set(present);
  return [...applied.keys()].filter((key) => !presentKeys.has(key));
}

/**
 * Build the session's activity feed, unstarted.
 *
 * Separate from the class for `buildSessionModels`' reason: construction stays a
 * total function of its inputs, and every subscription in the set is opened by the
 * one owner that will dispose it.
 */
export function createActivityFeed(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly clock: ConsoleClock;
  readonly registry: ActivityIndicatorRegistry;
}): ActivityFeed {
  const { bridge, sessionStore, clock, registry } = options;
  const read = new PushDrivenRead<GrowthActivitySnapshot>({
    clock,
    origin: ACTIVITY_FEED_ORIGIN,
    read: async () =>
      servedGrowthValueOrRaise(
        await bridge.growth.presenceActivityRead({ sessionId: sessionStore.sessionId }),
      ),
    // Typed `void` and taking no argument: the push says the room changed and says
    // nothing about how, which is what keeps this feed from holding a second copy
    // of the publisher's Awareness state.
    subscribe: (onChangeSignal) =>
      subscribeDaemonEvent<void>(bridge, PRESENCE_SUBSCRIBE_EVENT, onChangeSignal),
  });
  return new ActivityFeed(read, registry);
}
