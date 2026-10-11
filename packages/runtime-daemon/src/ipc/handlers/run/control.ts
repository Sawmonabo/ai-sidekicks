// The `run.*` controls a person sends a live run: an intervention, pause and resume, and the
// answers to a choice the provider holds the run on.
//
// - The registry parses each request against its descriptor's schema before the handler runs.
// - Every call is made by a device: the gateway stamps it on the call, never a request field, and
//   the intervention and the answer record it.
// - Pause, resume and the answers reach the driver that runs the run, found as the `driver.*`
//   handlers find it; an intervention reaches it through the intervention service.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { RUN_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/run/control";

import type { InterventionService } from "../../../interventions/service.js";
import type { WaitingMessage } from "../../../provider/driver/run-control.js";
import type { RunPauseControl } from "../../../session/run/pause.js";
import type {
  ProviderChoiceAnswerOrigin,
  ProviderChoiceResolver,
} from "../../../session/run/provider-choice.js";
import { callingDeviceOf } from "../../registry.js";
import { resolveDriverForRunOrThrow, type DriverDispatchDeps } from "../driver/resolution.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the `run.*` control handlers call, beside the driver lookup the `driver.*` verbs use. */
export interface RunControlHandlerDeps extends DriverDispatchDeps {
  readonly interventions: Pick<InterventionService, "applyIntervention">;
  readonly pauseControl: Pick<RunPauseControl, "pause" | "resume">;
  readonly choices: Pick<
    ProviderChoiceResolver,
    "resolveRefusalChoice" | "resolveUsageCreditsChoice"
  >;
  /** The messages waiting for a run, in send order, which a resume delivers as it continues. */
  readonly readWaitingMessages: (runId: RunId) => readonly WaitingMessage[];
}

/**
 * Binds `run.intervene`, `run.pause`, `run.resume`, `run.refusalChoiceResolve` and
 * `run.usageCreditsChoiceResolve` onto the registry. A stale pause or resume is refused
 * `run.version_stale` and a second or late answer `run.invalid_transition`, each with the run
 * untouched; a second binding on one registry throws.
 */
export function registerRunControlMethods(
  registry: MethodRegistry,
  deps: RunControlHandlerDeps,
): void {
  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.intervene"],
    async (request, ctx) =>
      deps.interventions.applyIntervention(request, {
        actor: callingDeviceOf(ctx, "run.intervene"),
      }),
  );

  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.pause"],
    async (request) => {
      const { driver } = resolveDriverForRunOrThrow(deps, request.targetRunId);
      return deps.pauseControl.pause(request, driver);
    },
  );

  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.resume"],
    async (request) => {
      const { driver } = resolveDriverForRunOrThrow(deps, request.targetRunId);
      return deps.pauseControl.resume(
        request,
        driver,
        deps.readWaitingMessages(request.targetRunId),
      );
    },
  );

  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.refusalChoiceResolve"],
    async (request, ctx) => {
      const origin: ProviderChoiceAnswerOrigin = {
        deviceId: callingDeviceOf(ctx, "run.refusalChoiceResolve"),
      };
      const { driver } = resolveDriverForRunOrThrow(deps, request.runId);
      return deps.choices.resolveRefusalChoice(request, origin, driver);
    },
  );

  registerDescribedMethod(
    registry,
    RUN_CONTROL_METHOD_DESCRIPTORS["run.usageCreditsChoiceResolve"],
    async (request, ctx) => {
      const origin: ProviderChoiceAnswerOrigin = {
        deviceId: callingDeviceOf(ctx, "run.usageCreditsChoiceResolve"),
      };
      const { driver } = resolveDriverForRunOrThrow(deps, request.runId);
      return deps.choices.resolveUsageCreditsChoice(request, origin, driver);
    },
  );
}
