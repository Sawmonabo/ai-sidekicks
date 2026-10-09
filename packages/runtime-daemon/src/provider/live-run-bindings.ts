// The live runtime binding of a run, read from the runs table and its binding rows: the driver a
// run-addressed handler acts through, and the binding a run-addressed driver call names.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { RunStateReader } from "../session/run/read.js";
import { isTerminalState } from "../session/run/transitions.js";
import type { RuntimeBinding, RuntimeBindingStore } from "./runtime-binding-store.js";

/** One run's live-binding resolution, scoped to the addressed session. */
export type RunBindingResolution =
  | { readonly kind: "unknown-run" }
  | { readonly kind: "no-live-binding" }
  | { readonly kind: "bound"; readonly driverName: ProviderName; readonly bindingId: string };

/**
 * Resolves a run to its live binding: the newest binding row of a run that has not ended. A run
 * keeps every binding it had, so the older rows are the ones a resume or a rewind replaced.
 */
export class LiveRunBindings {
  readonly #runs: Pick<RunStateReader, "getRun">;
  readonly #bindings: Pick<RuntimeBindingStore, "findByRun">;

  constructor(dependencies: {
    readonly runs: Pick<RunStateReader, "getRun">;
    readonly bindings: Pick<RuntimeBindingStore, "findByRun">;
  }) {
    this.#runs = dependencies.runs;
    this.#bindings = dependencies.bindings;
  }

  /** The driver a live run is bound to, or `undefined` for an unknown, ended or unbound run. */
  resolveDriverForRun(runId: RunId): ProviderName | undefined {
    const run = this.#runs.getRun(runId);
    return run === undefined ? undefined : this.#liveBindingOf(runId, run.state)?.driverName;
  }

  /** The run's live binding, refusing a run that is not the addressed session's as unknown. */
  resolveRunBinding(sessionId: SessionId, runId: RunId): RunBindingResolution {
    const run = this.#runs.getRun(runId);
    if (run === undefined || run.sessionId !== sessionId) {
      return { kind: "unknown-run" };
    }
    const binding = this.#liveBindingOf(runId, run.state);
    return binding === undefined
      ? { kind: "no-live-binding" }
      : { kind: "bound", driverName: binding.driverName, bindingId: binding.id };
  }

  #liveBindingOf(runId: RunId, state: RunState): RuntimeBinding | undefined {
    return isTerminalState(state) ? undefined : this.#bindings.findByRun(runId).at(-1);
  }
}
