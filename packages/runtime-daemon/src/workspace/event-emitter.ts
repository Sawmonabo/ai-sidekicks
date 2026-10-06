// Workspace lifecycle event emission: the one seam every workspace state transition appends its
// event through. It owns `workspace.preparing`, `workspace.ready`, `workspace.stale` and
// `workspace.archived` (which also carries the repo mount whose detach caused it). A mount's
// attach and detach are project changes, not session events, so nothing here records them.
//
// Workspace `busy` has no emit method. No caller-supplied `state`: each type names exactly one
// post-transition state, so a `workspace.ready` carrying `state: "archived"` (which parses clean)
// cannot be written.

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import {
  RepoWorkspaceLifecyclePayloadSchema,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import type {
  WorkspaceArchivedEvent,
  WorkspacePreparingEvent,
  WorkspaceReadyEvent,
  WorkspaceStaleEvent,
} from "@ai-sidekicks/contracts/event/declared-variants";

import type { EventLogAppendReceipt } from "../events/log-service.js";
import {
  LifecycleEventAppender,
  type LifecycleEventEmitterDeps,
  type LifecycleEventLinkage,
} from "./lifecycle-event-appender.js";

// Event names come from indexed access on the registered contracts variants (contracts exports no
// union), so a rename there fails this compile.
type WorkspaceEventName =
  | WorkspacePreparingEvent["type"]
  | WorkspaceReadyEvent["type"]
  | WorkspaceStaleEvent["type"]
  | WorkspaceArchivedEvent["type"];

const WORKSPACE_STATE_BY_EVENT_NAME = {
  "workspace.preparing": "preparing",
  "workspace.ready": "ready",
  "workspace.stale": "stale",
  "workspace.archived": "archived",
} as const satisfies Record<WorkspaceEventName, WorkspaceState>;

// Envelope version (MAJOR.MINOR) of these events. Parsed at load so a bad literal throws at import,
// not at the first emit.
const REPO_WORKSPACE_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/**
 * Input for the four workspace lifecycle events. Discrete fields, so `sessionId` and `actor` are
 * written into both envelope and payload from one value.
 */
export interface EmitWorkspaceEventInput extends LifecycleEventLinkage {
  /** The append path's sequence-allocation partition key. */
  readonly sessionId: string;
  readonly workspaceId: string;
  // Set on `workspace.preparing` (the pairing's first appearance) and on the detach cascade's
  // `workspace.archived`, so a reader knowing only the mount can attribute the archival.
  readonly repoMountId?: string;
  /** Envelope actor (`user_id | agent_id | null`); defaults to `null` (system). */
  readonly actor?: string | null;
}

/**
 * Appends workspace lifecycle events, one envelope per call. Each method resolves to the append
 * receipt, so a producer reads the `sequence` the append path assigned.
 */
export class WorkspaceEventEmitter {
  readonly #appender: LifecycleEventAppender;

  constructor(deps: LifecycleEventEmitterDeps) {
    this.#appender = new LifecycleEventAppender(deps, REPO_WORKSPACE_EVENT_VERSION);
  }

  /** Emit `workspace.preparing` — the workspace's materialization began. */
  async emitWorkspacePreparing(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.preparing", input);
  }

  /** Emit `workspace.ready` — the workspace is usable for execution. */
  async emitWorkspaceReady(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.ready", input);
  }

  /**
   * Emit `workspace.stale`: the workspace no longer reflects its mount and needs preparing again
   * before further use.
   */
  async emitWorkspaceStale(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.stale", input);
  }

  /**
   * Emit `workspace.archived`: the workspace reached its terminal state. Pass `repoMountId` when
   * the archival is a detach cascade's dependent transition.
   */
  async emitWorkspaceArchived(input: EmitWorkspaceEventInput): Promise<EventLogAppendReceipt> {
    return this.#appendWorkspaceEvent("workspace.archived", input);
  }

  async #appendWorkspaceEvent(
    type: WorkspaceEventName,
    input: EmitWorkspaceEventInput,
  ): Promise<EventLogAppendReceipt> {
    const payload = RepoWorkspaceLifecyclePayloadSchema.parse({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      // Omitted, not passed as `undefined`, when the event names no mount.
      ...(input.repoMountId !== undefined ? { repoMountId: input.repoMountId } : {}),
      state: WORKSPACE_STATE_BY_EVENT_NAME[type],
      actor: input.actor ?? null,
    });
    return this.#appender.append(type, payload, input);
  }
}
