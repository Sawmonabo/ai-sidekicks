/**
 * The Codex methods for compaction, skills and item injection, and the readers that turn the
 * provider's command list into command descriptors.
 */

import {
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
} from "@ai-sidekicks/contracts/provider/driver/driver";
import {
  ProviderCommandEntrySchema,
  type ProviderCommandEntry,
} from "@ai-sidekicks/contracts/provider/driver/transcript";
import { wireFreeFormString } from "@ai-sidekicks/contracts/session/session";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import { isPlainObject } from "../../../record-readers.js";

/** The provider's native compaction trigger and its typed evidence frame. */
export const CODEX_THREAD_COMPACT_START_METHOD = "thread/compact/start" as const;

/** The provider's live skill enumeration. */
export const CODEX_SKILLS_LIST_METHOD = "skills/list" as const;

/**
 * The item-injection method (`ThreadInjectItemsParams`, non-experimental at the pin): appends items
 * to a loaded thread's model-visible history, one way a conversation takes changed instructions
 * from its next turn. `items` accepts any JSON, so an unrecognized item is taken and dropped while
 * the request still succeeds.
 *
 * @consumedBy the Codex leg that hands a loaded conversation changed instructions
 */
export const CODEX_THREAD_INJECT_ITEMS_METHOD = "thread/inject_items" as const;

/**
 * Reads the boundary position off the compaction evidence frame. `null` at the pin, since
 * `ContextCompactedNotification` is `{ threadId, turnId }`; only a non-negative integer
 * `boundaryPosition` is accepted, so a pin that starts publishing one is picked up.
 */
export function readCodexCompactionBoundaryPosition(params: unknown): number | null {
  if (!isPlainObject(params)) {
    return null;
  }
  const declared = params["boundaryPosition"];
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
    return null;
  }
  return declared;
}

/**
 * Maps the provider's `skills/list` reply onto command entries, concatenating per-directory
 * groups. Pure: rejections are returned, not emitted. `providerAccountId` is the bound account or
 * `null`, never `""` or a wildcard; entries are deep-frozen because the list is shared state.
 */
export function readCodexProviderCommandEntries(
  response: unknown,
  providerAccountId: string | null,
): CodexProviderCommandReading {
  if (!isPlainObject(response)) {
    return CODEX_EMPTY_PROVIDER_COMMAND_READING;
  }
  const groups = response["data"];
  if (!Array.isArray(groups)) {
    return CODEX_EMPTY_PROVIDER_COMMAND_READING;
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
export interface CodexProviderCommandRejection {
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

/** The shared frozen empty reading, so no unreadable-reply path returns a mutable array. */
const CODEX_EMPTY_PROVIDER_COMMAND_READING: CodexProviderCommandReading = Object.freeze({
  entries: Object.freeze([]),
  rejections: Object.freeze([]),
});

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
