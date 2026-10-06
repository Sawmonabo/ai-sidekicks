// The Codex leg's provider commands: the readers that turn a `skills/list` reply into command
// entries, and the per-session enumeration, read once per session, discarded on `skills/changed`
// and with the session, and trimmed to the wire cap per reply.

import {
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
} from "@ai-sidekicks/contracts/provider/driver/length-limits";
import {
  ProviderCommandEntrySchema,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
} from "@ai-sidekicks/contracts/provider/driver/transcript";
import { wireFreeFormString } from "@ai-sidekicks/contracts/free-form-string";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { isPlainObject } from "../../record-readers.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { CodexTransportError } from "./session/errors.js";
import {
  type CodexLifecycleOptions,
  type CodexSessionRecord,
  soleActiveRunIdIn,
} from "./session/state.js";

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

/** The provider's live skill enumeration. */
const CODEX_SKILLS_LIST_METHOD = "skills/list" as const;

/**
 * Maps the provider's `skills/list` reply onto command entries, concatenating per-directory
 * groups. Pure: rejections are returned, not emitted. `providerAccountId` is the bound account or
 * `null`, never `""` or a wildcard; entries are deep-frozen because the list is shared state.
 * Throws `CodexTransportError` for a reply with no `data` list: reading it as no commands would
 * hold a false claim that the provider has none.
 */
function readCodexProviderCommandEntries(
  response: unknown,
  providerAccountId: string | null,
): CodexProviderCommandReading {
  const groups = isPlainObject(response) ? response["data"] : undefined;
  if (!Array.isArray(groups)) {
    throw new CodexTransportError(
      `The Codex app-server's "${CODEX_SKILLS_LIST_METHOD}" reply carries no skill list.`,
      { method: CODEX_SKILLS_LIST_METHOD },
    );
  }
  const entries: ProviderCommandEntry[] = [];
  const rejections: CodexProviderCommandRejection[] = [];
  for (const group of groups) {
    if (!isPlainObject(group)) {
      continue;
    }
    const skills = group["skills"];
    if (!Array.isArray(skills)) {
      continue;
    }
    for (const skill of skills) {
      const reading = readCodexProviderCommandEntry(skill, providerAccountId);
      if (reading.entry !== null) {
        entries.push(deepFreezeProviderCommandEntry(reading.entry));
      }
      rejections.push(...reading.rejections);
    }
  }
  return { entries: Object.freeze(entries), rejections: Object.freeze(rejections) };
}

/**
 * One field of one published entry that the contract's bounds refused. `dropped` says whether the
 * whole entry (name) or only the field was lost. The refused value is never carried (untrusted,
 * possibly enormous), only its length.
 */
interface CodexProviderCommandRejection {
  readonly rejectedField: "name" | "description" | "scope";
  readonly dropped: boolean;
  /** `null` where the provider published no string at all for the name. */
  readonly nameLength: number | null;
  /** `null` where the refused value was not a string. */
  readonly rejectedValueLength: number | null;
}

/** One `skills/list` reply's entries, and every field reading it refused. */
interface CodexProviderCommandReading {
  readonly entries: readonly ProviderCommandEntry[];
  readonly rejections: readonly CodexProviderCommandRejection[];
}

/**
 * Freezes one entry and its nested binding, keeping its declared type; a shallow freeze would let
 * `binding.providerAccountId` be rewritten, repointing a retained entry at another account.
 */
function deepFreezeProviderCommandEntry(entry: ProviderCommandEntry): ProviderCommandEntry {
  Object.freeze(entry.binding);
  return Object.freeze(entry);
}

const codexProviderCommandDescriptionSchema = wireFreeFormString(
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  "ProviderCommandEntry.description",
);

const codexProviderCommandScopeSchema = wireFreeFormString(
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  "ProviderCommandEntry.scope",
);

/**
 * One optional entry field: read, undeclared, or rejected by its bound. The rejected arm keeps a
 * refused value from reading as undeclared, a claim the provider never made.
 */
type CodexProviderCommandFieldReading =
  | { readonly kind: "read"; readonly value: string }
  | { readonly kind: "undeclared" }
  | { readonly kind: "rejected"; readonly valueLength: number | null };

/**
 * Reads one optional entry field against its bound; `blankIsUndeclared` is per field because only
 * some members can express "none" as a blank string.
 */
function readCodexProviderCommandField(
  raw: unknown,
  // Typed from the sibling const, not `z.ZodString`, because this module imports no zod.
  schema: typeof codexProviderCommandDescriptionSchema,
  blankIsUndeclared: boolean,
): CodexProviderCommandFieldReading {
  if (raw === undefined || raw === null) {
    return { kind: "undeclared" };
  }
  if (blankIsUndeclared && typeof raw === "string" && raw.trim().length === 0) {
    return { kind: "undeclared" };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { kind: "read", value: parsed.data };
  }
  return { kind: "rejected", valueLength: typeof raw === "string" ? raw.length : null };
}

/**
 * One `SkillMetadata`, normalized, with every field reading it refused. `enabled` is the
 * provider's Boolean verbatim (absent when unpublished, never a synthesized `true`), and a
 * disabled entry is still returned.
 */
function readCodexProviderCommandEntry(
  skill: unknown,
  providerAccountId: string | null,
): {
  readonly entry: ProviderCommandEntry | null;
  readonly rejections: CodexProviderCommandRejection[];
} {
  if (!isPlainObject(skill)) {
    // Not an object, so there is no name to attribute a record to.
    return { entry: null, rejections: [] };
  }
  // Absence is a positive claim, so undeclared (absent, `null`, or a blank description) and
  // rejected stay apart: a rejected description or scope becomes absent and is recorded, and only
  // an unreadable name drops the entry.
  const rawName = skill["name"];
  const nameLength = typeof rawName === "string" ? rawName.length : null;
  const description = readCodexProviderCommandField(
    skill["description"],
    codexProviderCommandDescriptionSchema,
    true,
  );
  const scope = readCodexProviderCommandField(
    skill["scope"],
    codexProviderCommandScopeSchema,
    false,
  );
  const enabled = skill["enabled"];
  const rejections: CodexProviderCommandRejection[] = [];
  if (description.kind === "rejected") {
    rejections.push({
      rejectedField: "description",
      dropped: false,
      nameLength,
      rejectedValueLength: description.valueLength,
    });
  }
  if (scope.kind === "rejected") {
    rejections.push({
      rejectedField: "scope",
      dropped: false,
      nameLength,
      rejectedValueLength: scope.valueLength,
    });
  }
  // Parsed through the contract's entry schema so a field this driver forgot to bound is refused.
  const candidate = {
    name: rawName,
    kind: "skill" as const,
    ...(description.kind === "read" ? { description: description.value } : {}),
    ...(scope.kind === "read" ? { scope: scope.value } : {}),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    // Fixed here so a caller cannot label Codex entries as another provider's.
    binding: { driverName: CODEX_DRIVER_NAME, providerAccountId },
  };
  const parsed = ProviderCommandEntrySchema.safeParse(candidate);
  if (parsed.success) {
    return { entry: parsed.data, rejections };
  }
  // Only the name can still fail here. The field records are discarded with the dropped entry.
  return {
    entry: null,
    rejections: [{ rejectedField: "name", dropped: true, nameLength, rejectedValueLength: null }],
  };
}
