// Provider-driver shapes a client also reads: the declared-loss vocabulary of a transcript
// operation, the compaction result, the provider-command enumeration and the output-speed state.

import { z } from "zod";
import { ProviderNameSchema, type ProviderName } from "./provider-account.js";
import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  type RunId,
} from "./provider-driver.js";
import { wireFreeFormString } from "./session.js";

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
  // The memo budget evicted older exchanges — whole exchanges only, never halves.
  "context_truncated",
  // An unpaired call took a synthetic error result rather than being dropped.
  "tool_call_history_repaired",
  // The memo floor: verbatim exchanges replaced by a bounded prose rendering.
  "conversation_history_summarized",
  // A logged turn's body could not be read when the fold ran, so the turn is carried with its
  // position and an empty body rather than dropped. Named because the alternatives, a turn that
  // never happened or one whose author said nothing, are both false.
  "turn_content_unavailable",
  // A logged turn's body exceeded the append-time plaintext ceiling and is stored as a
  // codepoint-boundary prefix; the fold carries the prefix and names the loss. Not
  // `context_truncated` (the memo budget evicting whole exchanges) and not
  // `turn_content_unavailable` (which would overstate a turn available as a prefix). Kept in the
  // vocabulary because the memo continuity-marker parser refuses a record carrying a token it
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
 * The result of a compaction attempt, not of the request, discriminated on `status` so no arm
 * carries a member another arm makes meaningless. `applied` is reachable only after the provider's
 * typed compaction frame is observed; `boundaryPosition` is required there, `number | null` so a
 * frame carrying no position is representable without being synthesized. `refused` means nothing
 * was sent; `failed` means something was sent and no boundary was witnessed. There is no
 * `capability_undeclared` reason: an undeclared flag refuses at the static capability gate with
 * `driver.capability_unsupported` before the driver is called, so an arm would encode one refusal
 * twice.
 */
export type DriverCompactionResult =
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the pre-dispatch presence check on the emulated leg did not find the command
  // in the provider's own enumeration for this binding. `not_permitted`: the run-control
  // adjudication denied the caller; produced by the daemon-side gate, never by a driver (which
  // runs no authorization), and it lives here because the refusal settles on the operation's own
  // result rather than as a JSON-RPC error.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: the driver's declared per-binding compaction bound elapsed with no typed
  // compaction frame. `binding_lost`: the binding stopped being live before one arrived.
  // `provider_error`: the mechanism itself errored. Every arm records a diagnostic; none can
  // settle `applied`.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

/**
 * Validates a {@link DriverCompactionResult} as a structural assertion, not an untrusted-result
 * envelope: the result is daemon-constructed from a settlement the daemon's own wait computed, and
 * the client SDK parses the reply with it. It keeps two structural rules mechanical: `applied`
 * without a `boundaryPosition` key does not parse, and no arm admits `capability_undeclared`. The
 * provider's own boundary position, the one untrusted number, is narrowed at the frame-normalize
 * boundary before it reaches this result.
 */
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
 * One enumerated provider command or skill. `binding` is the routing key, carried with the data so
 * a consumer cannot lose it by filtering a held list instead of re-reading; its
 * `providerAccountId` is nullable because a session need not have bound an account. The driver does
 * not filter: a disabled entry is returned, since dropping it would stop the result being the
 * provider's enumeration as observed and hide the difference between a disabled command and one
 * that does not exist. `enabled` governs offerability, not presence. This is enumeration and
 * discovery, not a dispatch channel: the only entry the driver sends is the compaction command,
 * reached through `compactContext`, which checks presence against this enumeration.
 */
export interface ProviderCommandEntry {
  name: string;
  // Distinguishes the two things providers publish under one syntax.
  kind: "command" | "skill";
  // Omitted, never an empty string, when the provider publishes none. Codex types a skill's
  // description as required, so a skill with none arrives as "", which the schema's
  // `wireFreeFormString` rejects; forwarding it verbatim would fail the enumeration on an honest
  // reading. Omission also says the truth: no description was published, not a blank one.
  description?: string | undefined;
  // Present only where the provider declares one (Codex skills do; the Claude handshake
  // enumeration does not), so absence means no scope was stated, never that it is unknown.
  scope?: string | undefined;
  // Present iff the provider declares one (Codex `skills/list` carries an `enabled` Boolean; the
  // Claude handshake enumeration draws no such distinction). Absent means no distinction on this
  // surface, never an unknown state, and never a driver-synthesized `true`.
  enabled?: boolean | undefined;
  binding: { driverName: ProviderName; providerAccountId: string | null };
}

/**
 * Validates a {@link ProviderCommandEntry}. Strict, siding with the result envelopes: the driver
 * builds it from what its provider published, so an unknown key is a driver bug. Both
 * provider-authored strings are `wireFreeFormString`-bounded because a local skill file's front
 * matter is operator-writable and the assembled list travels to a client.
 */
export const ProviderCommandEntrySchema: z.ZodType<ProviderCommandEntry, ProviderCommandEntry> = z
  .object({
    name: wireFreeFormString(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN, "ProviderCommandEntry.name"),
    kind: z.enum(["command", "skill"]),
    description: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.description",
    ).optional(),
    scope: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderCommandEntry.scope",
    ).optional(),
    enabled: z.boolean().optional(),
    binding: z
      .object({
        driverName: ProviderNameSchema,
        // Nullable, not `.optional()`: an account-less session is real (the account registry is a
        // spawn-time binding not every leg carries) and `null` states that none was bound. An
        // absent key would look like a driver that forgot to report one, and a placeholder (`""`,
        // "unknown", the driver name) would make the routing invariant unenforceable while looking
        // enforced, since two account-less bindings on different providers would compare equal on
        // the half of the pair meant to separate them.
        //
        // `null` matches nothing, never a wildcard: an account-less enumeration can be read but
        // never used to route a dispatch onto another binding. That is the consumer's obligation,
        // not something this schema enforces. A driver also reports `null` when it has no reader
        // for the account registry (neither establishment params object carries an account id);
        // the obligation reads the same on both, so neither authorizes a dispatch onto another
        // binding.
        providerAccountId: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * One live binding's enumeration. `runId` and `binding` together are provenance a client can read
 * and construct, not an addressing handle: neither alone is a key (a run has many bindings, and one
 * agent can hold bindings on the same provider and account across two runs). `complete: false`
 * means the provider published more entries than the cap admits and this group's tail was dropped;
 * the cap and the flag are per group.
 */
export interface ProviderCommandBindingGroup {
  // Nullable, and never omitted, for the same reason as `providerAccountId`. An enumeration
  // belongs to the binding, which outlives any one run, so no single run attributes it in two
  // cases: zero runs are live (the ordinary pre-first-turn palette read, which succeeds with `null`
  // rather than refusing), and two or more runs are live on the binding (picking one would be a
  // coin flip presented as provenance). Exactly one live run answers with that run. A last-bound
  // fallback is rejected: a never-cleared id naming a retired run is false provenance, worse than
  // the honest `null`.
  runId: RunId | null;
  binding: { driverName: ProviderName; providerAccountId: string | null };
  entries: ProviderCommandEntry[];
  complete: boolean;
}

/**
 * The reply of `listProviderCommands`: a list of binding groups, never a bare entry array, because
 * an agent can hold several live bindings and a flat array would strip provenance from an arbitrary
 * leg's commands. The driver operation returns exactly one group (its params name one binding); the
 * envelope is shared with the client-facing verb so the daemon's fan-out and merge across an
 * agent's bindings is a concatenation. The routing invariant (an entry is offerable and
 * dispatchable only through agents of the binding it was read under) is enforced at the daemon, not
 * here: a driver comparing the pair against itself would refuse every account-less read, since
 * `null` matches nothing by design. What each driver does enforce is a dispatch into the very
 * process whose enumeration it read, matched by that process's own identity.
 */
export interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}

/**
 * The provider's own report of its accelerated-output state, never a probe of its own and never
 * synthesized from the request. It is binding-held driver-session state, not a spawn return: the
 * declaring handshake arrives only within a turn-bearing exchange, so neither `createSession` nor
 * `resumeSession` can carry it (neither may spend a synthetic turn or block waiting for one). The
 * driver records it when the handshake arrives, on the first turn-bearing exchange the user's own
 * work produces, and holds it for the binding's life; until then every reader sees absent, never a
 * default. It is discarded with the session and deliberately not written to
 * `runtime_bindings.spawn_config` (what was requested, for resume) or `agents.output_speed` (the
 * operator's accepted choice): persisting an observation there would create a second, staler
 * record and make a mode that stopped being available look accepted after a restart. `declared`
 * is verbatim and not narrowed to `outputSpeedLevels`, which bounds what a caller may request; a
 * level the driver's table does not list is a real state under version skew, and coercing it would
 * fabricate a false reading. `reason` is the provider's own explanation, present only where it
 * gave one.
 */
export interface ProviderOutputSpeedState {
  declared: string;
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
