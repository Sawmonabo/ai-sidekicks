// Composing and agent activity: that work is happening right now, per channel.
//
// TWO MECHANISMS, DELIBERATELY NOT ONE. A human's composing indicator and an
// agent's activity indicator look alike on screen and are produced by opposite
// machinery, and collapsing them is the mistake this module exists to prevent:
//
//   • **A human's is timed.** A receiver clears after
//     `COMPOSING_RECEIVED_STALE_MS` without a refresh, so a client that vanished
//     mid-sentence does not leave a person composing forever. That bound sits well
//     inside the thirty-second Awareness staleness window.
//   • **An agent's is edge-triggered.** It is written by the daemon that owns the
//     run and cleared only by that run's own end edge. Expiring it on a receiver
//     timeout would make a long run flicker — the run is still going, and a
//     twenty-minute compile emits nothing while it does.
//
// SO THERE IS NO EXPIRY ON AN AGENT ENTRY, AND THAT IS THE POINT. Only a composing
// entry arms a clear timer. An agent entry leaves this registry by exactly two
// doors, both of them edges rather than deadlines:
// {@link ActivityIndicatorRegistry.clearAgentActivity}, which the run's own end
// edge calls, and {@link ActivityIndicatorRegistry.clearPublisher}, which the
// disconnect of the client that wrote it calls.
//
// `since` IS DISPLAY-ONLY. Every clear deadline is measured from the clock at the
// moment the entry was noted, never from the `since` the publisher sent. A
// publisher's clock is not this console's, and a surface that subtracted one from
// the other would expire an indicator early or late by the skew between two
// machines.
//
// NOTHING HERE CARRIES CONTENT. There is no message text, no keystroke, no draft —
// only who, where, and since when. And nothing here is durable: composing mints no
// event, so the registry is constructed per session and dies with it.
//
// WHERE THE ENTRIES COME FROM. `activity-feed.ts` is the one writer: it reads the
// session's live activity through the growth port — the Awareness fields
// `activity.typing` and `activity.runs`, which are registered in no contract and
// reached through no bridge namespace, so the port refuses them under both bridges
// and a scenario is what answers today — and folds each reading in here. It is
// deliberately the only one, because two writers would be two answers to who is
// composing where. The bounds and the two mechanisms are settled HERE rather than in
// that feed, because they are the part that is ours: the feed decides what a reading
// says, and this decides what an indicator's life is.

import { useCallback, useSyncExternalStore } from "react";

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../core/index.js";
import { COMPOSING_RECEIVED_STALE_MS } from "../core/index.js";

/** A human composing in one channel. No content, ever — only who, where, and since. */
export interface ComposingIndicator {
  readonly participantId: string;
  readonly channelId: string;
  /** Wire-supplied, display-only. Never an input to an expiry decision. */
  readonly since: string;
}

/** One live run, in the channel it is running in. Keyed by run id, per the field. */
export interface AgentActivityIndicator {
  readonly runId: string;
  readonly channelId: string;
  /** Wire-supplied, display-only. Never an input to an expiry decision. */
  readonly since: string;
}

/** What one channel currently shows. Both lists are in note order. */
export interface ChannelActivity {
  readonly composing: readonly ComposingIndicator[];
  readonly agentRuns: readonly AgentActivityIndicator[];
}

const NO_ACTIVITY: ChannelActivity = { composing: [], agentRuns: [] };

/**
 * How an indicator's ids become words.
 *
 * The activity fields carry a participant id and a run id and no names, so a
 * surface rendering them resolves both against the session projection. It travels
 * as a pair of functions rather than as a store handle so the renderer that
 * displays an indicator holds no second reader of the session's state.
 */
export interface ChannelActivityLabels {
  readonly participantLabel: (participantId: string) => string;
  /** The agent's name for one live run, or the run id when the projection has none. */
  readonly runLabel: (runId: string) => string;
}

interface ComposingEntry {
  readonly indicator: ComposingIndicator;
  readonly clearHandle: ScheduledHandle;
}

/**
 * The session's live indicators.
 *
 * A class with private fields and an injected clock: it owns timers, so it owns a
 * teardown, and a test drives every bound on frozen time with no real timer at all.
 * Constructed per session by whoever owns that session's surfaces — never at module
 * scope, because two sessions each have their own room.
 */
export class ActivityIndicatorRegistry {
  readonly #clock: ConsoleClock;
  readonly #changes = new Emitter<void>("activity indicator");
  readonly #composingByParticipantId = new Map<string, ComposingEntry>();
  readonly #agentRunsByRunId = new Map<string, AgentActivityIndicator>();
  readonly #activityByChannelId = new Map<string, ChannelActivity>();
  #composingLookup: ComposingLookup | undefined;
  #disposed = false;

  public constructor(clock: ConsoleClock) {
    this.#clock = clock;
  }

  /** Subscribe to indicator changes. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Record or refresh one human's composing indicator.
   *
   * Refreshing re-arms the clear rather than adding a second entry: a person
   * composes in one place at a time, so the key is the participant and a note
   * naming a different channel MOVES them rather than showing them in two rooms.
   */
  public noteComposing(indicator: ComposingIndicator): void {
    if (this.#disposed) {
      return;
    }
    this.#cancelComposing(indicator.participantId);
    const clearHandle = this.#clock.scheduleTimeout(() => {
      this.#composingByParticipantId.delete(indicator.participantId);
      this.#publish();
    }, COMPOSING_RECEIVED_STALE_MS);
    this.#composingByParticipantId.set(indicator.participantId, { indicator, clearHandle });
    this.#publish();
  }

  /** Clear one human's indicator now — the publisher said it stopped. */
  public clearComposing(participantId: string): void {
    if (!this.#cancelComposing(participantId)) {
      return;
    }
    this.#publish();
  }

  /**
   * Record one live run's activity.
   *
   * No timer is armed and none ever will be: this entry is cleared by its own run's
   * end edge and by nothing else.
   */
  public noteAgentActivity(indicator: AgentActivityIndicator): void {
    if (this.#disposed) {
      return;
    }
    this.#agentRunsByRunId.set(indicator.runId, indicator);
    this.#publish();
  }

  /** The run's end edge. The only door an agent entry leaves by. */
  public clearAgentActivity(runId: string): void {
    if (!this.#agentRunsByRunId.delete(runId)) {
      return;
    }
    this.#publish();
  }

  /**
   * Clear everything one client published.
   *
   * The Awareness-disconnect path: when a client drops, every indicator it wrote
   * clears at once through garbage collection, which is the intended failure rather
   * than a case to paper over. Agent entries go too — the daemon that owned those
   * runs is the client that left, so nothing is left to end them by edge.
   */
  public clearPublisher(participantId: string, runIds: readonly string[]): void {
    let changed = this.#cancelComposing(participantId);
    for (const runId of runIds) {
      changed = this.#agentRunsByRunId.delete(runId) || changed;
    }
    if (changed) {
      this.#publish();
    }
  }

  /**
   * What one channel shows.
   *
   * The result is REMEMBERED until the next change, and that is a correctness
   * requirement rather than a saving. React's external-store binding compares
   * snapshots by identity and re-renders — then re-reads — whenever they differ, so
   * a reader that composed a fresh array on every call would never converge. The
   * cache is cleared by the one method that emits, so a remembered value can never
   * outlive the state it was derived from.
   */
  public activityIn(channelId: string): ChannelActivity {
    const remembered = this.#activityByChannelId.get(channelId);
    if (remembered !== undefined) {
      return remembered;
    }
    const composing = [...this.#composingByParticipantId.values()]
      .map((entry) => entry.indicator)
      .filter((indicator) => indicator.channelId === channelId);
    const agentRuns = [...this.#agentRunsByRunId.values()].filter(
      (indicator) => indicator.channelId === channelId,
    );
    const activity =
      composing.length === 0 && agentRuns.length === 0 ? NO_ACTIVITY : { composing, agentRuns };
    this.#activityByChannelId.set(channelId, activity);
    return activity;
  }

  /** Whether one participant is composing anywhere. The roster row's question. */
  public composingChannelFor(participantId: string): string | undefined {
    return this.#composingByParticipantId.get(participantId)?.indicator.channelId;
  }

  /**
   * The roster's composing question, as a value whose identity is the reading.
   *
   * Remembered until the next change for {@link activityIn}'s reason, and consumed
   * for one more: the roster is memoized, so its marks move when this identity moves
   * and at no other time. A bound method handed down instead would keep ONE identity
   * for the life of the registry, and a mark would then refresh only when some
   * unrelated prop happened to move — which is a pencil that is right by accident and
   * wrong as soon as the accident stops arriving.
   */
  public composingLookup(): ComposingLookup {
    const remembered = this.#composingLookup;
    if (remembered !== undefined) {
      return remembered;
    }
    const lookup: ComposingLookup = (participantId) => this.composingChannelFor(participantId);
    this.#composingLookup = lookup;
    return lookup;
  }

  /** Drop everything and release every timer. Terminal. */
  public dispose(): void {
    this.#disposed = true;
    for (const participantId of [...this.#composingByParticipantId.keys()]) {
      this.#cancelComposing(participantId);
    }
    this.#agentRunsByRunId.clear();
  }

  /**
   * Invalidate the per-channel memo and tell every listener.
   *
   * One method rather than a cache clear beside each `emit`, because the two must
   * happen together and in this order: a listener that re-read between them would
   * be handed the value the change just invalidated.
   */
  #publish(): void {
    this.#activityByChannelId.clear();
    this.#composingLookup = undefined;
    this.#changes.emit();
  }

  /** Remove one composing entry and its armed clear. True when something was removed. */
  #cancelComposing(participantId: string): boolean {
    const existing = this.#composingByParticipantId.get(participantId);
    if (existing === undefined) {
      return false;
    }
    this.#clock.cancel(existing.clearHandle);
    this.#composingByParticipantId.delete(participantId);
    return true;
  }
}

/** Whether one participant is composing anywhere, asked of a settled reading. */
export type ComposingLookup = (participantId: string) => string | undefined;

/**
 * Read who is composing where from React.
 *
 * `useSyncExternalStore` over the same emitter {@link useChannelActivity} uses, for
 * the same reason and one more. The roster SAMPLED this registry during render and
 * subscribed to nothing, so a pencil appeared only when something else re-rendered the
 * section — which was the age wake-up, at a cadence that has since been cut to the
 * minute it renders. Subscribed, the mark moves when the indicator moves.
 */
export function useComposingLookup(registry: ActivityIndicatorRegistry): ComposingLookup {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.onChange(onStoreChange),
    [registry],
  );
  const read = useCallback(() => registry.composingLookup(), [registry]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Read one channel's live activity from React.
 *
 * `useSyncExternalStore` over the registry's own change emitter — the registry is
 * already an external store, and copying its entries into component state would be
 * the second source of truth the whole module is arranged to avoid. The registry
 * remembers each channel's result until its next change, which is what makes the
 * snapshot comparison converge.
 */
export function useChannelActivity(
  registry: ActivityIndicatorRegistry,
  channelId: string,
): ChannelActivity {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.onChange(onStoreChange),
    [registry],
  );
  const read = useCallback(() => registry.activityIn(channelId), [registry, channelId]);
  return useSyncExternalStore(subscribe, read, read);
}
