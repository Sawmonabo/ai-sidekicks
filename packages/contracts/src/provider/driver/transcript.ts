// Provider-driver shapes a client also reads: the declared-loss vocabulary of a transcript
// operation, the compaction result, the provider-command enumeration and the output-speed state.

import { z } from "zod";
import { ProviderNameSchema, type ProviderName } from "../name.js";
import {
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
} from "./caps.js";
import { type RunId } from "../../run/id.js";
import { wireFreeFormString } from "../../free-form-string.js";

// ---- Declared losses ----

/**
 * The closed vocabulary of what a transcript operation could not carry. A new kind is a deliberate
 * addition, never a free string. An empty list claims nothing was dropped, so a driver that does
 * not know what it lost may not emit one.
 */
export const DECLARED_LOSS_KINDS = [
  // Non-portable by both vendors' stated rules and never translated. Stripped unconditionally,
  // even on a same-provider replay where signatures would still validate: carrying them would owe
  // an exact reproduction of block order and count, whose failures surface as opaque signature
  // rejections rather than declared losses.
  "provider_private_reasoning",
  // The brief budget evicted older exchanges — whole exchanges only, never halves.
  "context_truncated",
  // An unpaired call took a synthetic error result rather than being dropped.
  "tool_call_history_repaired",
  // The brief floor: verbatim exchanges replaced by a bounded prose rendering.
  "conversation_history_summarized",
  // A logged turn's body could not be read when the fold ran, so the turn is carried with its
  // position and an empty body rather than dropped. Named because the alternatives, a turn that
  // never happened or one whose author said nothing, are both false.
  "turn_content_unavailable",
  // A logged turn's body exceeded the append-time plaintext ceiling and is stored as a
  // codepoint-boundary prefix; the fold carries the prefix and names the loss. Not
  // `context_truncated` (the brief budget evicting whole exchanges) and not
  // `turn_content_unavailable` (which would overstate a turn available as a prefix). Kept in the
  // vocabulary because the brief continuity-marker parser refuses a record carrying a token it
  // cannot place, and the unreadable-record upper bound reports this whole list.
  "turn_content_truncated",
] as const;

/** One member of {@link DECLARED_LOSS_KINDS}. */
export type DeclaredLossKind = (typeof DECLARED_LOSS_KINDS)[number];

/** Validates a {@link DeclaredLossKind}. */
export const DeclaredLossKindSchema: z.ZodType<DeclaredLossKind, DeclaredLossKind> =
  z.enum(DECLARED_LOSS_KINDS);

// ---- Compaction and provider commands ----

/**
 * The result of a compaction attempt. `applied` only after the provider's compaction frame was
 * seen; `refused` means nothing was sent; `failed` means something was sent and no boundary came.
 */
export type DriverCompactionResult =
  // `boundaryPosition` is `null` where the provider's frame carried none.
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the provider's own list for this binding lacks the command.
  // `not_permitted`: the daemon's permission check denied the caller; never a driver's.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: no compaction frame within the binding's bound. `binding_lost`: the binding
  // ended first. `provider_error`: the provider's mechanism errored.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

/** Validates a {@link DriverCompactionResult}; `applied` needs a `boundaryPosition` key. */
export const DriverCompactionResultSchema: z.ZodType<
  DriverCompactionResult,
  DriverCompactionResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      // `.nullable()`, not `.optional()`: null states that the provider's frame carried no
      // position, while an absent key would look like a driver that forgot to report one.
      boundaryPosition: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["command_absent", "not_permitted"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["wait_expired", "binding_lost", "provider_error"]),
    })
    .strict(),
]);

/**
 * The binding a provider-command enumeration was read under: the `(driverName, providerAccountId)`
 * routing pair a group and each of its entries carry. `providerAccountId` is `null` when the
 * session bound no account.
 */
export interface ProviderCommandBinding {
  driverName: ProviderName;
  providerAccountId: string | null;
}

/** Validates a {@link ProviderCommandBinding}. Strict: an unknown key is a driver bug. */
export const ProviderCommandBindingSchema: z.ZodType<
  ProviderCommandBinding,
  ProviderCommandBinding
> = z
  .object({
    driverName: ProviderNameSchema,
    // Nullable, not `.optional()`: an account-less session is real (the account registry is a
    // spawn-time binding not every leg carries) and `null` states that none was bound. An absent
    // key would look like a driver that forgot to report one, and a placeholder (`""`, "unknown",
    // the driver name) would make the routing invariant unenforceable while looking enforced,
    // since two account-less bindings on different providers would compare equal on the half of
    // the pair meant to separate them.
    //
    // `null` matches nothing, never a wildcard: an account-less enumeration can be read but never
    // used to route a dispatch onto another binding. That is the consumer's obligation, not
    // something this schema enforces. A driver also reports `null` when it has no reader for the
    // account registry (neither establishment params object carries an account id); the
    // obligation reads the same on both, so neither authorizes a dispatch onto another binding.
    providerAccountId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * One enumerated provider command, skill or working tool server's prompt, as the provider
 * listed it: a disabled entry is returned, not dropped, and `binding` is its routing key.
 */
export interface ProviderCommandEntry {
  name: string;
  // Distinguishes the things published under one syntax: a provider's command, a skill, and a
  // working tool server's prompt.
  kind: "command" | "skill" | "prompt";
  // Omitted, never an empty string, when the provider publishes none. Codex types a skill's
  // description as required, so a skill with none arrives as "", which the schema's
  // `wireFreeFormString` rejects; forwarding it verbatim would fail the enumeration on an honest
  // reading. Omission also says the truth: no description was published, not a blank one.
  description?: string | undefined;
  // The provider's own hint for what follows the word, present only where it publishes one.
  argumentHint?: string | undefined;
  // Present only where the provider declares one (Codex skills do; the Claude handshake
  // enumeration does not), so absence means no scope was stated, never that it is unknown.
  scope?: string | undefined;
  // Present iff the provider declares one (Codex `skills/list` carries an `enabled` Boolean; the
  // Claude handshake enumeration draws no such distinction). Absent means the provider draws no
  // distinction, never an unknown state, and never a driver-synthesized `true`.
  enabled?: boolean | undefined;
  // The tool server that publishes a prompt, which the list groups it under; present exactly on a
  // `prompt` entry.
  server?: string | undefined;
  binding: ProviderCommandBinding;
}

/**
 * Validates a {@link ProviderCommandEntry}. Strict, siding with the result envelopes: the driver
 * builds it from what its provider published, so an unknown key is a driver bug. Every
 * provider-authored string is `wireFreeFormString`-bounded because a local skill file's front
 * matter is the person's to write and the assembled list travels to a client.
 */
export const ProviderCommandEntrySchema: z.ZodType<ProviderCommandEntry, ProviderCommandEntry> = z
  .object({
    name: wireFreeFormString(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN, "ProviderCommandEntry.name"),
    kind: z.enum(["command", "skill", "prompt"]),
    description: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.description",
    ).optional(),
    argumentHint: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.argumentHint",
    ).optional(),
    scope: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderCommandEntry.scope",
    ).optional(),
    enabled: z.boolean().optional(),
    server: wireFreeFormString(
      DRIVER_MCP_SERVER_NAME_MAX_LEN,
      "ProviderCommandEntry.server",
    ).optional(),
    binding: ProviderCommandBindingSchema,
  })
  .strict()
  .refine((entry) => (entry.kind === "prompt") === (entry.server !== undefined), {
    message: "server is present exactly on a prompt entry",
    path: ["server"],
  });

/**
 * One live binding's command list, with where it came from. `complete: false` means the provider
 * listed more entries than the per-group cap and the tail was dropped.
 */
export interface ProviderCommandBindingGroup {
  // The one live run on the binding; `null` when none or several are live.
  runId: RunId | null;
  binding: ProviderCommandBinding;
  entries: ProviderCommandEntry[];
  complete: boolean;
}

/**
 * The reply of `listProviderCommands`: one group per live binding, so each entry keeps where it
 * came from. A driver returns exactly one group; the daemon concatenates an agent's groups.
 */
export interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}

/**
 * The provider's own report of its accelerated-output state, held for the binding's life from the
 * first declaration the provider makes, at spawn or thread establishment; absent until then and
 * never stored.
 */
export interface ProviderOutputSpeedState {
  /** The provider's level, verbatim; a level the driver does not list is kept, not coerced. */
  declared: string;
  /** The provider's own explanation, where it gave one. */
  reason?: string | undefined;
}

/** Validates a {@link ProviderOutputSpeedState}; strict, like `ProviderCommandEntrySchema`. */
export const ProviderOutputSpeedStateSchema: z.ZodType<
  ProviderOutputSpeedState,
  ProviderOutputSpeedState
> = z
  .object({
    declared: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderOutputSpeedState.declared",
    ),
    reason: wireFreeFormString(
      DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
      "ProviderOutputSpeedState.reason",
    ).optional(),
  })
  .strict();
