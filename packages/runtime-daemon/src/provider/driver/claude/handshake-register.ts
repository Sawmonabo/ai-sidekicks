// What each live Claude session declared, and what is read from it: the provider's command and
// skill surface from `system/init`, and its output-speed state from the `initialize` reply,
// replaced by each later `system/init` that reports one and reported once per run when the run's
// own handshake arrives.

import { type RunId } from "@ai-sidekicks/contracts/run/id";
import {
  ProviderCommandEntrySchema,
  type ProviderCommandBinding,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
} from "@ai-sidekicks/contracts/provider/driver/commands";
import { type ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  readDeclaredOutputSpeed,
  type RunOutputSpeedSettledListener,
} from "../../declared-output-speed.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "./capabilities.js";
import type { ClaudeFastModeDeclaration, ClaudeHandshakeDeclaration } from "./session/transport.js";
import type {
  ClaudeHeldHandshake,
  ClaudeSessionLifecycleDependencies,
  LiveClaudeSession,
} from "./session/state.js";
import { ClaudeSessionUnavailableError } from "./session/errors.js";

/** One session's command enumeration, less the run it is stamped with. */
export type ClaudeProviderCommandEnumeration = Omit<
  ProviderCommandListResult["bindings"][number],
  "runId"
>;

/**
 * One session's latest fast-mode reading, stamped like {@link ClaudeHeldHandshake}; `undefined`
 * where the provider reported no state or one the contract's bounds refuse.
 */
interface ClaudeHeldFastMode {
  readonly providerSessionId: string;
  readonly state: ProviderOutputSpeedState | undefined;
}

/** The run whose output speed settles on its session's next handshake, stamped like the above. */
interface ClaudeUnsettledRun {
  readonly providerSessionId: string;
  readonly runId: RunId;
}

/**
 * Holds each live session's handshake declaration, latest fast-mode declaration and the run whose
 * output speed has yet to settle, never persisted: stamped with the provider session id (see
 * {@link ClaudeHeldHandshake}) and discarded with the session.
 */
export class ClaudeHandshakeRegister {
  readonly #handshakeBySession: Map<SessionId, ClaudeHeldHandshake> = new Map();
  readonly #fastModeBySession: Map<SessionId, ClaudeHeldFastMode> = new Map();
  readonly #unsettledRunBySession: Map<SessionId, ClaudeUnsettledRun> = new Map();
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #readBoundProviderAccountId: ((sessionId: SessionId) => string | null) | undefined;
  readonly #onRunOutputSpeedSettled: RunOutputSpeedSettledListener;

  constructor(
    dependencies: Pick<
      ClaudeSessionLifecycleDependencies,
      "diagnostics" | "readBoundProviderAccountId"
    > & {
      /** Receives each run's settled declared fast-mode state, once. */
      readonly onRunOutputSpeedSettled: RunOutputSpeedSettledListener;
    },
  ) {
    this.#diagnostics = dependencies.diagnostics;
    this.#readBoundProviderAccountId = dependencies.readBoundProviderAccountId;
    this.#onRunOutputSpeedSettled = dependencies.onRunOutputSpeedSettled;
  }

  /**
   * Records one `system/init` declaration; the last wins, since the surface can change mid-run. A
   * declaration reporting a fast-mode state replaces the held one; one reporting none keeps it.
   */
  observeHandshakeDeclaration(
    sessionId: SessionId,
    providerSessionId: string,
    declaration: ClaudeHandshakeDeclaration,
  ): void {
    this.#handshakeBySession.set(sessionId, {
      providerSessionId,
      declaration,
      invocableCommandNames: new Set(declaration.slashCommands),
    });
    if (declaration.fastModeState !== null) {
      this.holdFastMode(sessionId, providerSessionId, declaration);
    }
    // The handshake of the turn the run started: whatever level it applied has taken effect.
    this.settleRunOutputSpeed(sessionId, providerSessionId);
  }

  /** Marks `runId` as the run whose output speed settles on this process's next handshake. */
  armRunOutputSpeed(sessionId: SessionId, providerSessionId: string, runId: RunId): void {
    this.#unsettledRunBySession.set(sessionId, { providerSessionId, runId });
  }

  /** Drops the armed run without a report: its turn was never written. */
  disarmRunOutputSpeed(sessionId: SessionId): void {
    this.#unsettledRunBySession.delete(sessionId);
  }

  /**
   * Reports the armed run's output speed as the state the process holds, once, and disarms it.
   * Nothing is reported for another process's run or where no state was ever read.
   */
  settleRunOutputSpeed(sessionId: SessionId, providerSessionId: string): void {
    const unsettled = this.#unsettledRunBySession.get(sessionId);
    if (unsettled?.providerSessionId !== providerSessionId) {
      return;
    }
    this.#unsettledRunBySession.delete(sessionId);
    const state = this.observedOutputSpeedFor(sessionId, providerSessionId);
    if (state !== undefined) {
      this.#onRunOutputSpeedSettled(sessionId, unsettled.runId, state);
    }
  }

  /** Discards the session's declarations and armed run: live reads of a replaced process. */
  forgetHandshake(sessionId: SessionId): void {
    this.#handshakeBySession.delete(sessionId);
    this.#fastModeBySession.delete(sessionId);
    this.#unsettledRunBySession.delete(sessionId);
  }

  // Answers only for the process the declaration was read from. The stamp is a last guard behind
  // registration clearing the record and retired channels being refused first.
  heldHandshakeFor(
    sessionId: SessionId,
    providerSessionId: string,
  ): ClaudeHeldHandshake | undefined {
    const held = this.#handshakeBySession.get(sessionId);
    return held?.providerSessionId === providerSessionId ? held : undefined;
  }

  /**
   * The command and skill entries one live session declared, all of them. Before the handshake it
   * answers empty. Throws when the account registry contradicts the admitted account.
   */
  enumerateProviderCommands(
    sessionId: SessionId,
    live: LiveClaudeSession,
  ): ClaudeProviderCommandEnumeration {
    const binding = {
      driverName: CLAUDE_DRIVER_NAME,
      // The record is primary, the registry port a cross-check; `null` is stated, not synthesized.
      providerAccountId: this.#resolveStampedProviderAccountId(sessionId, live),
    };
    const held = this.heldHandshakeFor(sessionId, live.providerSessionId);
    // Before the handshake (it rides a turn the user may not have made) answer empty, not refuse.
    const entries =
      held === undefined
        ? []
        : this.#composeProviderCommandEntries(sessionId, held.declaration, binding);
    return { binding, entries };
  }

  /**
   * Picks the provider account an enumeration's binding is stamped with. Throws when the account
   * registry names a different account than the admitted one; a `null` registry answer is silence.
   */
  #resolveStampedProviderAccountId(sessionId: SessionId, live: LiveClaudeSession): string | null {
    const admitted = live.admittedProviderAccountId;
    const registered = this.#readBoundProviderAccountId?.(sessionId) ?? null;
    if (admitted === null) {
      return registered;
    }
    if (registered === null || registered === admitted) {
      return admitted;
    }
    throw new ClaudeSessionUnavailableError("provider_account_ambiguous", {
      sessionId,
      detail:
        `The session was admitted against provider account ${admitted} while the daemon's ` +
        `account registry reports ${registered}; the enumeration is routed by that identity, ` +
        `so neither resolver may silently win.`,
    });
  }

  /**
   * The output-speed state the provider last declared for one live session, from its `initialize`
   * reply or a later `system/init`, or `undefined` where neither reported one. A declaration the
   * contract's bounds reject reads as absent; `cooldown` is carried as declared.
   */
  observedOutputSpeedFor(
    sessionId: SessionId,
    providerSessionId: string,
  ): ProviderOutputSpeedState | undefined {
    const held = this.#fastModeBySession.get(sessionId);
    return held?.providerSessionId === providerSessionId ? held.state : undefined;
  }

  /**
   * Records the fast-mode state a process reported, in its `initialize` reply at spawn or in a
   * handshake. Read once, as observed, so a declaration the bounds refuse emits its diagnostic
   * once.
   */
  holdFastMode(
    sessionId: SessionId,
    providerSessionId: string,
    declaration: ClaudeFastModeDeclaration,
  ): void {
    const state =
      declaration.fastModeState === null
        ? undefined
        : readDeclaredOutputSpeed(
            {
              provider: CLAUDE_DRIVER_NAME,
              sessionId,
              declared: declaration.fastModeState,
              reason: declaration.fastModeDisabledReason,
            },
            this.#diagnostics,
          );
    this.#fastModeBySession.set(sessionId, { providerSessionId, state });
  }

  // Composed at read time so the held state stays what the provider said. Each entry is bounded by
  // the contract's entry schema (provider-supplied names may be empty, NUL-bearing or over-long); a
  // rejected entry is dropped alone, with a diagnostic, so one bad name cannot empty the palette.
  #composeProviderCommandEntries(
    sessionId: SessionId,
    declaration: ClaudeHandshakeDeclaration,
    binding: ProviderCommandBinding,
  ): ProviderCommandEntry[] {
    const entries: ProviderCommandEntry[] = [];
    const admit = (candidate: ProviderCommandEntry): void => {
      const parsed = ProviderCommandEntrySchema.safeParse(candidate);
      if (parsed.success) {
        entries.push(parsed.data);
        return;
      }
      this.#diagnostics.emit({
        provider: "claude",
        kind: "provider_command_entry_rejected",
        rawWireType: null,
        dispositionReason:
          "the provider published a command or skill entry the contract's own bounds refuse; " +
          "it is dropped from this reply and its siblings are unaffected",
        details: {
          sessionId,
          entryKind: candidate.kind,
          entryScope: candidate.scope ?? null,
          // The failing field and length, never the untrusted name.
          rejectedField: parsed.error.issues[0]?.path.join(".") ?? "",
          nameLength: candidate.name.length,
        },
      });
    };
    for (const name of declaration.slashCommands) {
      admit({ name, kind: "command", binding });
    }
    for (const name of declaration.skills) {
      admit({ name, kind: "skill", binding });
    }
    for (const name of declaration.terminalSlashCommands) {
      // A command in kind; `scope` records its terminal-only reach.
      admit({ name, kind: "command", scope: "terminal", binding });
    }
    return entries;
  }
}
