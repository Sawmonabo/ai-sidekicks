// One session's collaboration models, and who owns their lifetime.
//
// TWO SIDEBAR SECTIONS SHARE ONE SET. The channel list and the roster are filled
// independently — the sidebar renders each through its own seat — but they read
// one session's channels, one session's presence, and one set of live indicators.
// Building a set per section would put two `ActivityIndicatorRegistry` instances
// behind one session, which is the second source of truth this console does not
// permit anywhere else and would not permit here either.
//
// SO THE HOLDER IS THE OWNER, AND IT IS AN INSTANCE, NOT A SINGLETON. The family's
// registrar constructs exactly one and both section descriptors close over it. A
// module-level holder would be shared by every window that loaded this module, and
// an auxiliary window's sidebar is a different sidebar.
//
// A CACHE OF ONE, WHICH IS WHAT A SIDEBAR ACTUALLY NEEDS. A sidebar shows one
// session at a time, so asking for a different session disposes the previous set —
// its subscription released, its scheduler disposed, its clear timers cancelled —
// and builds a fresh one. That is a bound stated by construction rather than a cap
// with a rationale: the holder cannot grow past one entry.
//
// A SECTION BODY UNMOUNTING DOES NOT RELEASE THE MODELS, DELIBERATELY. The sidebar
// opens a section that carries an amber or red item and collapses every other one,
// so it has to know what each section holds while that section shows nothing. A read
// released on unmount would leave the sidebar deciding that question from a stale
// answer, or re-reading on every collapse. The session switch is the release point,
// and the window's teardown is the terminal one.
//
// THE CLOCK COMES FROM THE BRIDGE, NOT FROM THE PLATFORM. Under the fixture the
// scenario's frozen clock is the only clock the renderer reads, so every deadline
// in these models advances exactly when a scenario tick says it does. Under the
// live bridge it is the real one.

import type { SessionStore } from "../store/index.js";
import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "./activity-model.js";
import { createChannelDirectory, type ChannelDirectory } from "./channel-model.js";
import { createPresenceRoster, type PresenceRoster } from "./presence-model.js";

/** Everything one session's collaboration surfaces read from. */
export interface CollaborationSessionModels {
  readonly sessionId: string;
  readonly clock: ConsoleClock;
  readonly activity: ActivityIndicatorRegistry;
  readonly channelDirectory: ChannelDirectory;
  readonly presenceRoster: PresenceRoster;
  readonly labels: ChannelActivityLabels;
}

/**
 * The one owner of a session's collaboration models.
 *
 * Constructed by `registerCollaborationSections` and captured by both section
 * descriptors. Every model it builds is started here — subscription first, then the
 * read — so a section body never starts one from a render.
 */
export class CollaborationSessionModelHolder {
  #current: CollaborationSessionModels | undefined;

  /**
   * The models for one session, building them on first ask.
   *
   * Switching sessions disposes the previous set before building the next, so no
   * subscription and no timer survives a session the sidebar has left.
   */
  public modelsFor(bridge: ConsoleBridge, sessionStore: SessionStore): CollaborationSessionModels {
    const existing = this.#current;
    if (existing !== undefined && existing.sessionId === sessionStore.sessionId) {
      return existing;
    }
    this.dispose();
    const clock = bridge.scenarioEngine?.clock ?? new RealClock();
    const built: CollaborationSessionModels = {
      sessionId: sessionStore.sessionId,
      clock,
      activity: new ActivityIndicatorRegistry(clock),
      channelDirectory: createChannelDirectory({ bridge, sessionStore, clock }),
      presenceRoster: createPresenceRoster({ bridge, sessionStore, clock }),
      labels: sessionProjectionLabels(sessionStore),
    };
    built.channelDirectory.start();
    built.presenceRoster.start();
    this.#current = built;
    return built;
  }

  /** Release whatever is held. Terminal for the models it disposes, not for the holder. */
  public dispose(): void {
    const held = this.#current;
    this.#current = undefined;
    if (held === undefined) {
      return;
    }
    held.channelDirectory.dispose();
    held.presenceRoster.dispose();
    held.activity.dispose();
  }
}

/**
 * Resolve a participant and a run to words, against the session's own projection.
 *
 * The activity fields carry ids and no names, and presence carries a participant id
 * and no name either, so this is the one place either becomes readable. It reads the
 * store's projection at call time rather than holding a copy, and falls back to the
 * wire id — which is a string an operator can act on — rather than to a blank or to
 * a composed placeholder that would read as a name nobody chose.
 */
export function sessionProjectionLabels(sessionStore: SessionStore): ChannelActivityLabels {
  return {
    participantLabel: (participantId) =>
      projectedName(sessionStore, "participant", participantId) ?? participantId,
    runLabel: (runId) => {
      // A run's own projection names its agent where the log carried one; failing
      // that the agent partition is asked under the same id, because a run keyed by
      // its agent is the shape the activity field's run id resolves through. Neither
      // is invented: both are reads, and the id survives when both come back empty.
      return (
        projectedName(sessionStore, "run", runId) ??
        projectedName(sessionStore, "agent", runId) ??
        runId
      );
    },
  };
}

/** One entity's projected display name, when the log carried one. */
function projectedName(
  sessionStore: SessionStore,
  kind: "participant" | "run" | "agent",
  id: string,
): string | undefined {
  const entity = sessionStore.snapshot().partitions[kind][id];
  const name = entity?.body?.["name"];
  return typeof name === "string" && name !== "" ? name : undefined;
}
