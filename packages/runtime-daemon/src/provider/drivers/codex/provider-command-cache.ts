// The Codex leg's held provider-command enumeration: read from `skills/list` once per session,
// discarded on `skills/changed` and with the session, and trimmed to the wire cap per reply.

import { DRIVER_PROVIDER_COMMAND_ENTRIES_MAX } from "@ai-sidekicks/contracts/provider-driver";
import type {
  ProviderCommandEntry,
  ProviderCommandListResult,
} from "@ai-sidekicks/contracts/provider-driver-transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import {
  type CodexLifecycleOptions,
  type CodexSessionRecord,
  soleActiveRunIdIn,
} from "./session-state.js";
import {
  CODEX_SKILLS_LIST_METHOD,
  type CodexProviderCommandRejection,
  readCodexProviderCommandEntries,
} from "./provider-commands.js";

/** Holds each session's command enumeration and composes the capped reply from it. */
export class CodexProviderCommandCache {
  readonly #options: Pick<CodexLifecycleOptions, "diagnostics">;
  // Live command enumeration per session, held uncapped: the cap applies when a result is
  // composed. Discarded on `skills/changed` and with the session.
  readonly #providerCommandEnumerations = new Map<SessionId, readonly ProviderCommandEntry[]>();
  // The invalidation epoch each held enumeration was read under: a `skills/list` in flight during
  // `skills/changed` would otherwise store a pre-change listing. Symbols, not a counter, since a
  // reused session id could match a reset counter.
  readonly #providerCommandEnumerationEpochs = new Map<SessionId, symbol>();

  constructor(options: Pick<CodexLifecycleOptions, "diagnostics">) {
    this.#options = options;
  }

  /**
   * The capped command list for one session's record, from the held enumeration or a fresh read.
   * A trimmed reply says `complete: false` and records a diagnostic.
   */
  async composeProviderCommandList(
    sessionId: SessionId,
    record: CodexSessionRecord,
  ): Promise<ProviderCommandListResult> {
    const providerAccountId = record.spawnConfig.providerAccountId ?? null;
    const held = await this.#heldProviderCommandsFor(sessionId, record, providerAccountId);
    const complete = held.length <= DRIVER_PROVIDER_COMMAND_ENTRIES_MAX;
    const entries = complete ? [...held] : held.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    if (!complete) {
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "provider_command_entries_truncated",
        rawWireType: CODEX_SKILLS_LIST_METHOD,
        dispositionReason:
          "the provider published more entries than the wire-and-render cap admits; the " +
          "reply's tail was dropped and the driver's held enumeration was left whole",
        details: {
          sessionId,
          heldCount: held.length,
          returnedCount: entries.length,
        },
      });
    }
    return {
      bindings: [
        {
          // From this read's record, not by session id: a resume landing mid-request must not
          // stamp the successor's run here.
          runId: soleActiveRunIdIn(record),
          binding: { driverName: CODEX_DRIVER_NAME, providerAccountId },
          entries,
          complete,
        },
      ],
    };
  }

  /**
   * The held enumeration, read from the provider if absent. The epoch captured before the request
   * is re-checked before storing, so an invalidation mid-flight leaves the reading uncached.
   */
  async #heldProviderCommandsFor(
    sessionId: SessionId,
    record: CodexSessionRecord,
    providerAccountId: string | null,
  ): Promise<readonly ProviderCommandEntry[]> {
    const held = this.#providerCommandEnumerations.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const readEpoch = this.#providerCommandEnumerationEpochFor(sessionId);
    // Empty params on purpose: an empty `cwds` means this connection's spawn cwd and follows the
    // provider if it scans more. No `forceReload`: freshness comes from `skills/changed`.
    const response = await record.connection.request(CODEX_SKILLS_LIST_METHOD, {});
    const reading = readCodexProviderCommandEntries(response, providerAccountId);
    for (const rejection of reading.rejections) {
      this.#reportProviderCommandEntryRejected(sessionId, rejection);
    }
    if (this.#providerCommandEnumerationEpochs.get(sessionId) === readEpoch) {
      this.#providerCommandEnumerations.set(sessionId, reading.entries);
    }
    return reading.entries;
  }

  /**
   * Reports a field the contract's bounds refused; absence is a positive claim, so a silent drop
   * would misstate the provider. Only lengths are carried, never the refused value.
   */
  #reportProviderCommandEntryRejected(
    sessionId: SessionId,
    rejection: CodexProviderCommandRejection,
  ): void {
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "provider_command_entry_rejected",
      rawWireType: CODEX_SKILLS_LIST_METHOD,
      dispositionReason: rejection.dropped
        ? "the provider published a command or skill entry the contract's own bounds refuse; " +
          "it is dropped from this reply and its siblings are unaffected"
        : "the provider declared a command or skill field the contract's own bounds refuse; " +
          "the entry is kept and the field reads ABSENT, which on this contract means the " +
          "provider declared none",
      details: {
        sessionId,
        entryKind: "skill",
        rejectedField: rejection.rejectedField,
        dropped: rejection.dropped,
        nameLength: rejection.nameLength,
        rejectedValueLength: rejection.rejectedValueLength,
      },
    });
  }

  #providerCommandEnumerationEpochFor(sessionId: SessionId): symbol {
    const current = this.#providerCommandEnumerationEpochs.get(sessionId);
    if (current !== undefined) {
      return current;
    }
    const minted = Symbol("codex-provider-command-enumeration");
    this.#providerCommandEnumerationEpochs.set(sessionId, minted);
    return minted;
  }

  /** Clears list and epoch together; deleting the epoch fails an in-flight read's re-check. */
  discardProviderCommandEnumeration(sessionId: SessionId): void {
    this.#providerCommandEnumerations.delete(sessionId);
    this.#providerCommandEnumerationEpochs.delete(sessionId);
  }
}
