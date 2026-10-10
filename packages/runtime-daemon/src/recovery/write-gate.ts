// Refuses a mutating call that would write on top of read state the daemon cannot trust. Until
// the restart's pass has listed the sessions it must rebuild, or once the local store has failed,
// the whole node refuses; the stop, the restart and the flush are still taken, since they are how
// a person gets out of a stuck recovery and none writes session state. A call that names no
// session can reach any, through a project, a mount, a workspace or a tree, so it waits for the
// whole pass. From then on, a session the pass is still rebuilding refuses the calls that name it,
// and so does a session whose history is damaged, except its own two recovery actions; every
// other session takes its writes.

import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_WRITE_REFUSED_CODE,
  type DaemonWriteRefusedDetails,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { DelegatingRegistry } from "../ipc/registry.js";
import { refuseCallNamingSession } from "./session-write-refusal.js";
import type { RecoveryStatusTracker } from "./status.js";

const METHODS_TAKEN_WHILE_RECOVERING: ReadonlySet<string> = new Set([
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.stop"].method,
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.restart"].method,
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.flush"].method,
]);

// The two actions a session with damaged history offers.
const METHODS_TAKEN_BY_A_DAMAGED_SESSION: ReadonlySet<string> = new Set([
  SESSION_METHOD_DESCRIPTORS["session.recoveryContinue"].method,
  SESSION_METHOD_DESCRIPTORS["session.recoveryDelete"].method,
]);

/** Wraps a registry so its mutating calls wait for state the daemon can trust. */
export class RecoveryWriteGate {
  readonly #status: Pick<RecoveryStatusTracker, "readNodeWriteRefusal" | "readSessionCallRefusal">;

  /** `status` answers, at each call, whether the node and the named session take writes. */
  constructor(
    status: Pick<RecoveryStatusTracker, "readNodeWriteRefusal" | "readSessionCallRefusal">,
  ) {
    this.#status = status;
  }

  /**
   * Returns a registry that dispatches through `inner`, refusing a mutating call other than the
   * stop, the restart and the flush with `daemon.write_refused` while the node takes no writes,
   * and one that names a session the pass is still rebuilding, or one with damaged history, with
   * `session.write_refused`.
   */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new DelegatingRegistry(inner, async (method, params, ctx) => {
      this.#refuseUntrustedWrite(inner, method, params);
      return inner.dispatch(method, params, ctx);
    });
  }

  #refuseUntrustedWrite(inner: MethodRegistry, method: string, params: unknown): void {
    if (inner.isMutating(method) !== true || METHODS_TAKEN_WHILE_RECOVERING.has(method)) {
      return;
    }
    const sessionId = readNamedSession(params);
    const recovery = this.#status.readNodeWriteRefusal(sessionId !== undefined);
    if (recovery !== undefined) {
      const detail: DaemonWriteRefusedDetails = { recovery };
      throw new DaemonDomainError(
        `The service is not taking ${method} until its recovery lets it; it is ${recovery}`,
        {
          code: DAEMON_WRITE_REFUSED_CODE,
          jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
          detail: { ...detail },
        },
      );
    }
    if (sessionId !== undefined && !METHODS_TAKEN_BY_A_DAMAGED_SESSION.has(method)) {
      refuseCallNamingSession(this.#status, sessionId, method);
    }
  }
}

// The session a call names, before its parameters are parsed: its `sessionId` member. One that
// is not a session id names none, and the method's own schema refuses it.
function readNamedSession(params: unknown): SessionId | undefined {
  if (typeof params !== "object" || params === null || !("sessionId" in params)) {
    return undefined;
  }
  const parsed = SessionIdSchema.safeParse(params.sessionId);
  return parsed.success ? parsed.data : undefined;
}
