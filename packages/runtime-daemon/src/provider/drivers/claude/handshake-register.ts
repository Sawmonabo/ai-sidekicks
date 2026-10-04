// The `system/init` declaration each live Claude session made, and what is read from it: the
// provider's command and skill surface and its output-speed state.

import { DRIVER_PROVIDER_COMMAND_ENTRIES_MAX } from "@ai-sidekicks/contracts/provider-driver";
import {
  ProviderCommandEntrySchema,
  ProviderOutputSpeedStateSchema,
  type ProviderCommandBinding,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
  type ProviderOutputSpeedState,
} from "@ai-sidekicks/contracts/provider-driver-transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "./capabilities.js";
import type { ClaudeHandshakeDeclaration } from "./session-transport.js";
import type {
  ClaudeHeldHandshake,
  ClaudeSessionLifecycleDependencies,
  LiveClaudeSession,
} from "./session-state.js";
import { ClaudeSessionUnavailableError } from "./session-errors.js";

/** One session's command enumeration, less the run it is stamped with. */
export type ClaudeProviderCommandEnumeration = Omit<
  ProviderCommandListResult["bindings"][number],
  "runId"
>;

/**
 * Holds each live session's handshake declaration, never persisted: stamped with the provider
 * session id (see {@link ClaudeHeldHandshake}) and discarded with the session.
 */
export class ClaudeHandshakeRegister {
  readonly #handshakeBySession: Map<SessionId, ClaudeHeldHandshake> = new Map();
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #readBoundProviderAccountId: ((sessionId: SessionId) => string | null) | undefined;

  constructor(
    dependencies: Pick<
      ClaudeSessionLifecycleDependencies,
      "diagnostics" | "readBoundProviderAccountId"
    >,
  ) {
    this.#diagnostics = dependencies.diagnostics;
    this.#readBoundProviderAccountId = dependencies.readBoundProviderAccountId;
  }

  /** Records one `system/init` declaration; the last wins, since the surface can change mid-run. */
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
  }

  /** Discards the session's declaration: a live read of a process that is gone or replaced. */
  forgetHandshake(sessionId: SessionId): void {
    this.#handshakeBySession.delete(sessionId);
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
   * The command and skill entries one live session declared, capped at the contract's maximum with
   * `complete: false` and a diagnostic when trimmed. Before the handshake it answers empty and
   * complete. Throws when the account registry contradicts the admitted account.
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
    const declared =
      held === undefined
        ? []
        : this.#composeProviderCommandEntries(sessionId, held.declaration, binding);
    const admitted = declared.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    if (admitted.length < declared.length) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "provider_command_entries_truncated",
        rawWireType: null,
        dispositionReason:
          "the provider published more command and skill entries than one group admits; the " +
          "tail is dropped from this reply and the held enumeration is unchanged",
        details: {
          sessionId,
          declaredEntryCount: declared.length,
          admittedEntryCount: admitted.length,
        },
      });
    }
    return { binding, entries: admitted, complete: admitted.length === declared.length };
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
   * The output-speed state the provider declared for one live session, or `undefined` before it
   * has. A declaration the contract's bounds reject reads as absent, with a diagnostic; `cooldown`
   * is carried as declared.
   */
  observedOutputSpeedFor(
    sessionId: SessionId,
    providerSessionId: string,
  ): ProviderOutputSpeedState | undefined {
    const held = this.heldHandshakeFor(sessionId, providerSessionId);
    if (held === undefined) {
      return undefined;
    }
    const declared = held.declaration.fastModeState;
    if (declared === null) {
      return undefined;
    }
    const reason = held.declaration.fastModeDisabledReason;
    const parsed = ProviderOutputSpeedStateSchema.safeParse({
      declared,
      ...(reason === null ? {} : { reason }),
    });
    if (parsed.success) {
      return parsed.data;
    }
    this.#diagnostics.emit({
      provider: "claude",
      kind: "output_speed_state_rejected",
      rawWireType: null,
      dispositionReason:
        "the provider declared an output-speed state the contract's own bounds refuse; this " +
        "binding reads as having no observation until it declares another",
      details: {
        sessionId,
        // The failing field and lengths, never the untrusted values.
        rejectedField: parsed.error.issues[0]?.path.join(".") ?? "",
        declaredLength: declared.length,
        reasonLength: reason === null ? null : reason.length,
      },
    });
    return undefined;
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
