// ClaudeDriver — the Claude provider driver entry point (Plan-005 Phase 3, T3.6).
//
// Composition root for the Claude leg: it owns no logic of its own, binding the
// lifecycle band (T3.6, `lifecycle.ts`) and the intervention band (T3.7,
// `intervention.ts`) into the shape the daemon's `ProviderRegistry` registers.
// The two bands are coupled through exactly one narrow port —
// `ClaudeRunChannelLookup` — so the dispatcher can find the channel a run is
// bound to without reaching into session state it must not mutate.
//
// WHY `Pick<ProviderDriver, ...>` AND NOT `implements ProviderDriver`. This class
// implements the six operations PR-A owns. The other eight — `rollbackTo`,
// `respondToRequest`, `setSessionGoal`, `clearSessionGoal`, `listModels`,
// `listModes`, `getCapabilities`, `probeAuth` — are authored by sibling Phase-3
// tasks (T3.8 capabilities/models/modes, T3.14 interactive requests + auth probe,
// T3.15 the R8 parity operations). Declaring the full interface today would force
// throwing stubs into the driver, and a driver that answers a contract operation
// by throwing is indistinguishable from one whose provider refused — the exact
// conflation I-005-2 and I-005-4 exist to prevent. The `Pick` binds every
// signature this class DOES implement to the contract with zero drift, so
// widening to the full `ProviderDriver` when the sibling bands land is purely
// additive: change the type argument, add the methods, and any drift becomes a
// compile error rather than a runtime surprise.

import type {
  ApplyInterventionParams,
  CloseSessionParams,
  CreateSessionParams,
  DriverInterventionResult,
  DriverResumeResult,
  InterruptRunParams,
  ProviderDriver,
  ProviderSessionHandle,
  ResumeSessionParams,
  StartRunParams,
} from "@ai-sidekicks/contracts";

import { ClaudeInterventionDispatcher } from "./intervention.js";
import { ClaudeSessionLifecycle, type ClaudeSessionLifecycleDependencies } from "./lifecycle.js";

// Curated rather than `export *`: this barrel is the driver's public surface, and
// a star re-export would enlist every future symbol added to either band
// automatically — the surface would grow by accident instead of by decision. The
// sibling `capabilities.ts` / `tools.ts` modules are deliberately absent for the
// same reason: whoever widens `ClaudeDriverOperations` toward the full
// 14-operation `ProviderDriver` surface adds their exports alongside the
// operations that consume them, so the barrel never advertises a capability the
// driver object cannot yet serve.
export {
  ClaudeInterventionDispatcher,
  CLAUDE_STEER_FALLBACK_ACTION,
  type ClaudeInterventionDispatcherDependencies,
} from "./intervention.js";
export {
  ClaudeAuthenticationRequiredError,
  ClaudeControlRequestRefusedError,
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  type ClaudeChannelDisposalReason,
  type ClaudeControlRequest,
  type ClaudeControlRequestRefusedFields,
  type ClaudeControlResponse,
  type ClaudeInterruptControlRequest,
  type ClaudeResumedSessionAttachment,
  type ClaudeRunChannelLookup,
  type ClaudeRunDispatch,
  type ClaudeRunDispatchResolver,
  type ClaudeSessionAttachment,
  type ClaudeSessionChannel,
  type ClaudeSessionLifecycleDependencies,
  type ClaudeSessionResumeRequest,
  type ClaudeSessionSpawnRequest,
  type ClaudeSessionTransport,
  type ClaudeSessionUnavailableContext,
  type ClaudeSessionUnavailableFields,
  type ClaudeSessionUnavailableReason,
  type ClaudeSpawnBoundLegs,
  type ClaudeUserTextFrame,
} from "./lifecycle.js";

// The operations PR-A owns, named once so the class declaration and any consumer
// assertion read from the same list.
export type ClaudeDriverOperations = Pick<
  ProviderDriver,
  | "createSession"
  | "resumeSession"
  | "startRun"
  | "interruptRun"
  | "applyIntervention"
  | "closeSession"
>;

export type ClaudeDriverDependencies = ClaudeSessionLifecycleDependencies;

export class ClaudeDriver implements ClaudeDriverOperations {
  readonly #lifecycle: ClaudeSessionLifecycle;
  readonly #interventionDispatcher: ClaudeInterventionDispatcher;

  constructor(dependencies: ClaudeDriverDependencies) {
    this.#lifecycle = new ClaudeSessionLifecycle(dependencies);
    this.#interventionDispatcher = new ClaudeInterventionDispatcher({
      channelLookup: this.#lifecycle,
    });
  }

  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return await this.#lifecycle.createSession(params);
  }

  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.resumeSession(params);
  }

  async startRun(params: StartRunParams): Promise<void> {
    await this.#lifecycle.startRun(params);
  }

  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#lifecycle.interruptRun(params);
  }

  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return await this.#interventionDispatcher.applyIntervention(params);
  }

  async closeSession(params: CloseSessionParams): Promise<void> {
    await this.#lifecycle.closeSession(params);
  }
}
