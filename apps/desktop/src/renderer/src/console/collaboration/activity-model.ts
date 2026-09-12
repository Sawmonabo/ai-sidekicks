// Agent activity: that work is happening right now, per channel.
//
// AN AGENT'S INDICATOR IS EDGE-TRIGGERED, AND THAT IS THE POINT. It is written by the
// daemon that owns the run and cleared only by that run's own end edge. Expiring it on
// a receiver timeout would make a long run flicker — the run is still going, and a
// twenty-minute compile emits nothing while it does. So nothing here arms a timer, and
// an entry leaves this registry by exactly one door:
// {@link ActivityIndicatorRegistry.clearAgentActivity}, which the run's end edge calls.
//
// `since` IS DISPLAY-ONLY. A publisher's clock is not this console's, and a surface
// that subtracted one from the other would report an age it cannot measure.
//
// NOTHING HERE CARRIES CONTENT. There is no message text, no keystroke, no draft —
// only which run, where, and since when. And nothing here is durable: the registry is
// constructed per session and dies with it.
//
// WHERE THE ENTRIES COME FROM. `activity-feed.ts` is the one writer: it reads the
// session's live activity through the growth port — the Awareness field `activity.runs`,
// which is registered in no contract and reached through no bridge namespace, so the
// port refuses it under both bridges and a scenario is what answers today — and folds
// each reading in here. It is deliberately the only one, because two writers would be
// two answers to which run is working where.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, type Unsubscribe } from "../core/index.js";

/** One live run, in the channel it is running in. Keyed by run id, per the field. */
export interface AgentActivityIndicator {
  readonly runId: string;
  readonly channelId: string;
  /** Wire-supplied, display-only. Never an input to an expiry decision. */
  readonly since: string;
}

/** What one channel currently shows. The list is in note order. */
export interface ChannelActivity {
  readonly agentRuns: readonly AgentActivityIndicator[];
}

/**
 * How an indicator's run id becomes words.
 *
 * The activity field carries a run id and no name, so a surface rendering one resolves
 * it against the session projection. It travels as a function rather than as a store
 * handle so the renderer that displays an indicator holds no second reader of the
 * session's state.
 */
export interface ChannelActivityLabels {
  /** The agent's name for one live run, or the run id when the projection has none. */
  readonly runLabel: (runId: string) => string;
}

const NO_ACTIVITY: ChannelActivity = { agentRuns: [] };

/**
 * The session's live indicators.
 *
 * A class with private fields: it owns a memo and an emitter, so it owns a teardown.
 * Constructed per session by whoever owns that session's surfaces — never at module
 * scope, because two sessions each have their own room.
 *
 * NO CLOCK, because there is no deadline to measure: every entry leaves by its run's
 * own end edge.
 */
export class ActivityIndicatorRegistry {
  readonly #changes = new Emitter<void>("activity indicator");
  readonly #agentRunsByRunId = new Map<string, AgentActivityIndicator>();
  readonly #activityByChannelId = new Map<string, ChannelActivity>();
  #disposed = false;

  /** Subscribe to indicator changes. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
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

  /** The run's end edge. The only door an entry leaves by. */
  public clearAgentActivity(runId: string): void {
    if (!this.#agentRunsByRunId.delete(runId)) {
      return;
    }
    this.#publish();
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
    const agentRuns = [...this.#agentRunsByRunId.values()].filter(
      (indicator) => indicator.channelId === channelId,
    );
    const activity = agentRuns.length === 0 ? NO_ACTIVITY : { agentRuns };
    this.#activityByChannelId.set(channelId, activity);
    return activity;
  }

  /** Drop everything. Terminal. */
  public dispose(): void {
    this.#disposed = true;
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
    this.#changes.emit();
  }
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
