/**
 * How a session's subagent policy is realized for Claude, and the gate that limits how many
 * subagents run at once.
 */

import { type SessionId } from "@ai-sidekicks/contracts";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import { ClaudeSessionUnavailableError } from "./session-errors.js";
import type { SubagentDefinition, SubagentPolicy } from "../../provider-driver.js";

/**
 * Supervised postures never let commands run outside the sandbox: every non-`trusted` posture runs
 * with the always-armed permission prompt, and the daemon's prompt tool adjudicates every call.
 */
export const CLAUDE_SUPERVISED_ALLOWS_UNSANDBOXED_COMMANDS = false;

/**
 * The subagent depth ceiling this driver clamps to; a policy asking for less gets less. Depth
 * multiplies a run's blast radius and the daemon answers for every level, so it is bounded.
 */
export const CLAUDE_SUBAGENT_MAX_DEPTH_CEILING: number = 5;

// Permission modes under which a subagent's tool calls still pass the daemon's permission prompt;
// a mode that skips it or is unknown cannot be held at the boundary. An absent mode inherits the
// session's always-armed prompt.
const CLAUDE_BOUNDARY_MEDIATABLE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "plan",
]);

/** Why one subagent definition was withheld from the spawn. */
export interface ClaudeWithheldSubagentDefinition {
  readonly name: string;
  readonly reason: string;
}

/** A subagent policy split into what this driver will spawn and what it refused. */
interface ClaudeSubagentPolicyRealization {
  readonly policy: SubagentPolicy;
  readonly withheld: readonly ClaudeWithheldSubagentDefinition[];
}

/**
 * Admits the definitions this driver can mediate at the daemon boundary and withholds the rest;
 * `maxDepth` is clamped, not refused, since depth can be met partially and a definition cannot.
 */
export function realizeClaudeSubagentPolicy(
  policy: SubagentPolicy,
): ClaudeSubagentPolicyRealization {
  if (!policy.enabled) {
    return { policy, withheld: [] };
  }
  const admitted: SubagentDefinition[] = [];
  const withheld: ClaudeWithheldSubagentDefinition[] = [];
  for (const definition of policy.definitions) {
    const permissionMode = definition.permissionMode;
    if (
      permissionMode === undefined ||
      CLAUDE_BOUNDARY_MEDIATABLE_PERMISSION_MODES.has(permissionMode)
    ) {
      admitted.push(definition);
      continue;
    }
    withheld.push({
      name: definition.name,
      reason: `permission mode "${permissionMode}" bypasses the daemon permission prompt, so this subagent's tool calls could not be held at the daemon boundary`,
    });
  }
  return {
    policy: {
      enabled: true,
      maxDepth: Math.min(policy.maxDepth, CLAUDE_SUBAGENT_MAX_DEPTH_CEILING),
      maxConcurrent: policy.maxConcurrent,
      definitions: admitted,
    },
    withheld,
  };
}

/** Releases one held subagent slot. Idempotent: a double release frees one slot. */
export type ClaudeSubagentSlotRelease = () => void;

/** One queued admission, retained so a disposal can name who it abandoned. */
interface ClaudeSubagentSlotWaiter {
  readonly subagentId: string;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

/**
 * The port the transport awaits before dispatching a subagent-originated tool call. The daemon
 * enforces `maxConcurrent` at the tool-call boundary, since the provider documents no cap. The
 * release from `admit` must be called when the call settles, on every path; there is no timeout
 * (reclaiming on a guess could exceed the cap), and `admit` rejects once its session is disposed.
 */
export interface ClaudeSubagentAdmissionPort {
  admit(subagentId: string): Promise<ClaudeSubagentSlotRelease>;
  /** Fails every waiter. Called when the guarded session is disposed. */
  dispose(): void;
}

/**
 * Holds beyond-cap subagent tool calls at the daemon boundary, in arrival order.
 * `observeLiveSubagentCount` only reports a breach the gate cannot hold (subagents that call no
 * tool) as a diagnostic, never a failed run.
 */
export class ClaudeSubagentConcurrencyGate implements ClaudeSubagentAdmissionPort {
  readonly #sessionId: SessionId;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxConcurrent: number;
  readonly #waiters: ClaudeSubagentSlotWaiter[] = [];
  #heldSlotCount = 0;
  #reportedBreachCeiling = 0;
  #disposed = false;

  constructor(options: {
    readonly sessionId: SessionId;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxConcurrent: number;
  }) {
    this.#sessionId = options.sessionId;
    this.#diagnostics = options.diagnostics;
    // A cap below one would deadlock every call, so it floors at one; `enabled: false` builds no
    // gate.
    this.#maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  }

  /** Slots currently held. Exposed for the breach comparison and for tests. */
  get heldSlotCount(): number {
    return this.#heldSlotCount;
  }

  get waitingCallCount(): number {
    return this.#waiters.length;
  }

  /** Takes a slot, waiting in arrival order when all are held. Rejects once disposed. */
  async admit(subagentId: string): Promise<ClaudeSubagentSlotRelease> {
    this.#assertLive(subagentId);
    if (this.#heldSlotCount < this.#maxConcurrent) {
      // Take the slot in the same synchronous step as the test; after an `await` a second caller
      // would read the old count.
      this.#heldSlotCount += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        this.#waiters.push({ subagentId, resolve, reject });
      });
      // The releasing call handed its slot over without decrementing, so the count already includes
      // this admission; re-incrementing here would open a window for a third caller.
      this.#assertLive(subagentId);
    }
    let released = false;
    return () => {
      // Idempotent: a transport releasing on both a success path and a `finally` must not free two.
      if (released) {
        return;
      }
      released = true;
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter !== undefined) {
        nextWaiter.resolve();
        return;
      }
      this.#heldSlotCount -= 1;
    };
  }

  /** Fails every waiter and later admission; held slots stay, their releases are in flight. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // Drain by splice, not iterate-then-clear: a rejection handler that re-enters `admit` must
    // find an empty queue, not one being walked.
    const abandonedWaiters = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of abandonedWaiters) {
      waiter.reject(this.#composeDisposedError(waiter.subagentId));
    }
  }

  #assertLive(subagentId: string): void {
    if (this.#disposed) {
      throw this.#composeDisposedError(subagentId);
    }
  }

  #composeDisposedError(subagentId: string): ClaudeSessionUnavailableError {
    return new ClaudeSessionUnavailableError("no_live_session", {
      sessionId: this.#sessionId,
      detail: `Subagent ${subagentId} was waiting for a concurrency slot when the session was disposed.`,
    });
  }

  /** Records the live subagent count observed; one diagnostic per new ceiling, not a stream. */
  observeLiveSubagentCount(liveSubagentCount: number): void {
    if (
      liveSubagentCount <= this.#maxConcurrent ||
      liveSubagentCount <= this.#reportedBreachCeiling
    ) {
      return;
    }
    this.#reportedBreachCeiling = liveSubagentCount;
    this.#diagnostics.emit({
      provider: "claude",
      kind: "subagent_concurrency_breach",
      rawWireType: null,
      dispositionReason:
        "more subagents were observed alive than the declared concurrency cap admits; the cap is enforced at the tool-call boundary and never fails a run",
      details: {
        sessionId: this.#sessionId,
        maxConcurrent: this.#maxConcurrent,
        liveSubagentCount,
      },
    });
  }
}
