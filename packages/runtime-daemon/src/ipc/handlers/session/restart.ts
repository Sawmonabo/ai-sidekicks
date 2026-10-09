// `session.restart`: starts a session's provider process again after it ended and stayed down,
// resuming the session's conversation through the provider's own resume.
//
// The registry parses the request before the handler runs. The driver is found as the `driver.*`
// handlers find one and gated on `resume`; the driver clears its crash count, says the provider is
// back with a `provider_restarted` notice once it runs, and on a process several sessions share
// brings back every session it held.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { ResumeSessionParams } from "../../../provider/driver/contract.js";
import type { ProviderRegistry } from "../../../provider/driver/registry.js";
import { DaemonDomainError } from "../../domain-error.js";
import { lookupDriverOrThrow, refuseSessionNotFound } from "../driver/resolution.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** The provider a session ran on, and its last binding rebuilt as the params of a resume. */
interface SessionRestartTarget {
  readonly driverName: ProviderName;
  readonly params: ResumeSessionParams;
}

/** What `session.restart`'s handler calls. */
export interface SessionRestartDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /**
   * The session's restart target, or `undefined` for a session this daemon does not hold or one
   * with no binding to resume from.
   */
  readonly resolveRestartTarget: (sessionId: SessionId) => SessionRestartTarget | undefined;
}

/**
 * Binds `session.restart` onto the registry. A session with no restart target is refused
 * `session.not_found`, a driver that cannot resume `driver.capability_unsupported`, and a resume
 * the provider could not make `driver.unavailable`, whose `data.fields` carry the driver, the
 * recovery condition (`reauth-required` when the provider needs a sign-in) and the provider's own
 * failure detail. A second binding on one registry throws.
 */
export function registerSessionRestart(registry: MethodRegistry, deps: SessionRestartDeps): void {
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.restart"],
    async (request) => {
      const target = deps.resolveRestartTarget(request.sessionId);
      if (target === undefined) {
        refuseSessionNotFound();
      }
      const driver = lookupDriverOrThrow(deps.providerRegistry, target.driverName);
      deps.providerRegistry.checkCapability(target.driverName, "resume");
      const result = await driver.restartSession(target.params);
      if (result.status === "failed") {
        throw new DaemonDomainError("The provider could not restart the session", {
          code: "driver.unavailable",
          jsonRpcCode: JsonRpcErrorCode.InternalError,
          detail: {
            driverId: target.driverName,
            recoveryCondition: result.recoveryCondition,
            providerFailureDetail: result.providerFailureDetail,
          },
        });
      }
      return {};
    },
  );
}
