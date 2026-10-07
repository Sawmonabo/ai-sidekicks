// Refuses every mutating call while the node's recovery state is not healthy, so nothing writes
// on top of read state the daemon cannot yet trust. The stop, the restart and the flush are still
// taken: they are how a person gets out of a stuck recovery, and none of them writes session state.

import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  DAEMON_WRITE_REFUSED_CODE,
  type DaemonRecoveryState,
  type DaemonWriteRefusedDetails,
} from "@ai-sidekicks/contracts/daemon/recovery";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type {
  Handler,
  HandlerContext,
  MethodRegistry,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts/jsonrpc/registry";

import { DaemonDomainError } from "../ipc/domain-error.js";

const METHODS_TAKEN_WHILE_RECOVERING: ReadonlySet<string> = new Set([
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.stop"].method,
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.restart"].method,
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.flush"].method,
]);

/** Wraps a registry so its mutating calls wait for a healthy recovery state. */
export class RecoveryWriteGate {
  readonly #readOverall: () => DaemonRecoveryState;

  /** `readOverall` answers the node's overall recovery state at each call. */
  constructor(readOverall: () => DaemonRecoveryState) {
    this.#readOverall = readOverall;
  }

  /**
   * Returns a registry that dispatches through `inner`, refusing a mutating call other than the
   * stop, the restart and the flush with `daemon.write_refused` while the state is not healthy.
   */
  wrap(inner: MethodRegistry): MethodRegistry {
    return new GatedRegistry(inner, (method) => {
      if (inner.isMutating(method) !== true || METHODS_TAKEN_WHILE_RECOVERING.has(method)) {
        return;
      }
      const recovery = this.#readOverall();
      if (recovery === "healthy") {
        return;
      }
      const detail: DaemonWriteRefusedDetails = { recovery };
      throw new DaemonDomainError(
        `The service is not taking ${method} until its recovery is healthy; it is ${recovery}`,
        {
          code: DAEMON_WRITE_REFUSED_CODE,
          jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
          detail: { ...detail },
        },
      );
    });
  }
}

// Delegates everything to the inner registry; only `dispatch` is checked first.
class GatedRegistry implements MethodRegistry {
  readonly #inner: MethodRegistry;
  readonly #check: (method: string) => void;

  constructor(inner: MethodRegistry, check: (method: string) => void) {
    this.#inner = inner;
    this.#check = check;
  }

  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    // `opts` is forwarded only when present (exactOptionalPropertyTypes).
    if (opts === undefined) {
      this.#inner.register(method, paramsSchema, resultSchema, handler);
    } else {
      this.#inner.register(method, paramsSchema, resultSchema, handler, opts);
    }
  }

  async dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    this.#check(method);
    return this.#inner.dispatch(method, params, ctx);
  }

  has(method: string): boolean {
    return this.#inner.has(method);
  }

  isMutating(method: string): boolean | undefined {
    return this.#inner.isMutating(method);
  }
}
