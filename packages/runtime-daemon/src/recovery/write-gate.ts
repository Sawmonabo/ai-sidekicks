// Refuses a mutating call that would write on top of read state the daemon cannot trust. While
// the restart's pass runs, or once the local store has failed, the whole node refuses, so nothing
// is admitted before the store is rebuilt; the stop, the restart and the flush are still taken,
// since they are how a person gets out of a stuck recovery and none writes session state. Once
// the pass has ended, only a session whose history is damaged refuses the calls that name it,
// except its own two recovery actions; every other session takes its writes.

import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_WRITE_REFUSED_CODE,
  type DaemonWriteRefusedDetails,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { DelegatingRegistry } from "../ipc/registry.js";
import { refuseWriteToDamagedSession } from "./session-write-refusal.js";
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
  readonly #status: Pick<RecoveryStatusTracker, "readNodeWriteRefusal" | "readSessionWriteRefusal">;

  /** `status` answers, at each call, whether the node and the named session take writes. */
  constructor(
    status: Pick<RecoveryStatusTracker, "readNodeWriteRefusal" | "readSessionWriteRefusal">,
  ) {
    this.#status = status;
  }

  /**
   * Returns a registry that dispatches through `inner`, refusing a mutating call other than the
   * stop, the restart and the flush with `daemon.write_refused` while the node takes no writes,
   * and one that names a session with damaged history with `session.write_refused`.
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
    const recovery = this.#status.readNodeWriteRefusal();
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
    const sessionId = readNamedSession(params);
    if (sessionId !== undefined && !METHODS_TAKEN_BY_A_DAMAGED_SESSION.has(method)) {
      refuseWriteToDamagedSession(this.#status, sessionId, method);
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
