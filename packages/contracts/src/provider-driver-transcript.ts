// Provider-driver shapes for the canonical transcript, context compaction and provider commands.

import { z } from "zod";
import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  type ProviderSessionHandle,
  type RunId,
} from "./provider-driver.js";
import { wireFreeFormString, type SessionId } from "./session.js";

// ---- Canonical transcript export and replay ----

// The canonical transcript is a projection the daemon folds from the session event log, so its
// shapes are daemon-constructed and plain TypeScript. Content is bounded, normalized taxonomy:
// anything a provider held that never became an event is absent by construction, which is what
// the declared-loss rule surfaces.

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

/** Who authored a turn. The transcript carries no third author in V1. */
export type CanonicalTranscriptRole = "user" | "assistant";

/**
 * Whether a reasoning block was ever visible to the user. The strip keys on this, not on
 * `reasoningKind`, because a filter matching one kind name would leave that kind's redacted
 * sibling behind and break the multi-turn protocol. Summaries are user-visible, hence canonical.
 */
export type CanonicalReasoningDisclosure = "private" | "summary";

/**
 * Whether a tool result came from the provider or was minted by the pairing repair. A repaired
 * result is a declared loss, and a consumer that cannot tell the two apart cannot honor that.
 */
export type CanonicalToolResultProvenance = "provider" | "repaired";

/**
 * One unit of turn content. Every arm carries `position`, the session-log sequence of the event
 * that contributed it: derived provenance projected from the log, never a second record of the
 * session's order. It is required on every arm because a bound filters on it, and an absent
 * position would exempt its segment from every bound. Steps that re-home a segment keep the value,
 * so positions within a turn ascend as the fold builds them but need not once the pairing repair
 * moves a result behind its call. A `tool_call` carries no enclosing-block member while a
 * `tool_result` does, so the strip can never drop a call yet can orphan a result, which is what the
 * pairing repair answers; hence the repair must run after the strip.
 */
export type CanonicalTranscriptSegment =
  | {
      kind: "text";
      position: number;
      text: string;
      // Set when the row's body was unavailable at fold time. `text` is then empty, because the
      // fold never invents content, and the segment is kept so the turn survives with its
      // position. Every projection carrying one owes the matching declared loss.
      contentUnavailable?: boolean | undefined;
      // Set on the stand-in emitted for an id-less tool result whose enclosing reasoning block
      // resolved `private` at turn close. The body was read and withheld, so `text` is empty and
      // `contentUnavailable` stays absent (setting it would claim a read failure that never
      // happened). It is a `text` arm rather than a `tool_result` because that arm requires
      // `toolCallId`, and a synthetic id would give the pairing repair a call no provider made. It
      // rides the segment it governs and survives any positional bound the segment survives;
      // without it, a bound between the result and its later-logged private reasoning row would
      // leave the export declaring nothing. Never rendered or exported: the strip drops the segment
      // and declares `provider_private_reasoning`. One literal because only `private` withholds a
      // read body; an `unknown` enclosure keeps its placeholder on the `contentUnavailable` path.
      withheldEnclosure?: "private" | undefined;
    }
  | {
      kind: "reasoning";
      position: number;
      blockId: string;
      // The provider's own block-kind label, carried verbatim for diagnostics; the strip keys on
      // `disclosure`, not on this.
      reasoningKind: string;
      disclosure: CanonicalReasoningDisclosure;
      text: string;
    }
  | {
      kind: "tool_call";
      position: number;
      // The canonical id: replay never re-mints one or reuses one across two calls; the
      // target-facing id comes from the identity map.
      toolCallId: string;
      toolName: string;
      // The arguments as the provider serialized them; re-encoding a parsed object would change
      // bytes the target may hash or echo.
      argumentsJson: string;
      // As on the `text` arm. An unreadable body leaves `argumentsJson` empty rather than dropping
      // the call, whose id the pairing repair needs.
      contentUnavailable?: boolean | undefined;
    }
  | {
      kind: "tool_result";
      position: number;
      toolCallId: string;
      outcome: "succeeded" | "failed";
      provenance: CanonicalToolResultProvenance;
      text: string;
      // Present when the provider emitted this result inside a reasoning block; stripping that
      // block removes the result and orphans its call, the only way an orphan arises from a
      // well-formed transcript.
      enclosingReasoningBlockId?: string | undefined;
      // How the fold resolved that enclosure at turn close, and the only carrier of that
      // resolution that survives a positional bound: the block id names a sibling segment a bound
      // may cut away, while this member rides the result. Recorded only for the two dispositions
      // that withhold; a portable (`summary`) enclosure and a citation of a block from another turn
      // leave it absent, since nothing branches on either.
      //   `private`  the enclosing block was read and is not portable;
      //   `unknown`  the enclosure could not be established portable (the turn's reasoning row was
      //              unreadable, or the block carried a disclosure this fold does not classify).
      //              Fail-closed: content that might be private travels with the block.
      enclosureDisclosure?: "private" | "unknown" | undefined;
      // As on the `text` arm.
      contentUnavailable?: boolean | undefined;
    };

/** One ordered turn of the canonical transcript. */
export interface CanonicalTranscriptTurn {
  // The session-log sequence of the event that opened this turn (its first segment). Turns ascend
  // strictly in it. Consecutive same-role events coalesce into an open turn and keep their own,
  // higher, positions on their segments, so this member bounds nothing: a filter on it would admit
  // every later event folded into a turn that opened early.
  position: number;
  role: CanonicalTranscriptRole;
  segments: readonly CanonicalTranscriptSegment[];
}

/**
 * The daemon-side fold of a run's normalized events into ordered turns; it never crosses a wire and
 * is never persisted.
 */
export interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at: two folds at one position render identically, and one
  // taken after an appended event does not.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[];
}

/**
 * Input of `exportTranscript`: the folded projection and the boundary it is exported against. The
 * driver retains exactly the segments whose `position` is at or below `boundary` and drops any turn
 * left empty. The filter is per segment, not per turn, because the fold coalesces consecutive
 * same-role events into one turn positioned at the first, so a turn-level filter would carry later
 * events' content across the boundary. It is a deterministic filter over data the driver already
 * holds and equals the fold bounded at the same position, so it is a no-op on an already-bounded
 * projection.
 */
export interface ExportTranscriptParams {
  sessionId: SessionId;
  transcript: CanonicalTranscriptProjection;
  // Export up to and including this normalized session position, the vocabulary of
  // `ForkConversationParams.position` and `CanonicalTranscriptSegment.position`.
  boundary: number;
}

/** Return of `ProviderDriver.exportTranscript()`. */
export interface DriverTranscriptExportResult {
  // Provider-shaped replay frames, untyped on purpose: the pinned injection surface takes an
  // untyped array and validates neither shape nor tool-call pairing, so the daemon owns both and a
  // type here would assure a check nobody performs.
  frames: unknown[];
  // What the strip and repair steps of the ordered pipeline removed or repaired, by class.
  declaredLosses: DeclaredLossKind[];
}

/** Validates a {@link DriverTranscriptExportResult}; strict. */
export const DriverTranscriptExportResultSchema: z.ZodType<
  DriverTranscriptExportResult,
  DriverTranscriptExportResult
> = z
  .object({
    frames: z.array(z.unknown()),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict();

/** Params of `replayTranscript`: a fresh target session and the frames to inject into it. */
export interface ReplayTranscriptParams {
  // A fresh session handle. Replay never writes to the session the transcript came from.
  target: ProviderSessionHandle;
  frames: unknown[];
}

/**
 * Return of `ProviderDriver.replayTranscript()`. Flat rather than discriminated, unlike
 * `ForkConversationResult`, because `declaredLosses` is required on both arms: an `applied` replay
 * that stripped provider-private reasoning still lost something. The arm-scoped content rule rides
 * the schema below, since expressing it in the type would need the union this shape avoids.
 */
export interface DriverTranscriptReplayResult {
  // `degraded` means the memo floor stood in: the conversation moved and the losses say what came
  // along. It is not a failure; a target that cannot be reached at all throws.
  status: "applied" | "degraded";
  declaredLosses: DeclaredLossKind[];
}

/** Validates a {@link DriverTranscriptReplayResult}; strict, with arm-scoped loss rules. */
export const DriverTranscriptReplayResultSchema: z.ZodType<
  DriverTranscriptReplayResult,
  DriverTranscriptReplayResult
> = z
  .object({
    status: z.enum(["applied", "degraded"]),
    declaredLosses: z.array(DeclaredLossKindSchema),
  })
  .strict()
  // `degraded` here has one cause, the memo floor standing in, so it must name
  // `conversation_history_summarized`. Enforced rather than narrated: the flat shape admits
  // `{status: 'degraded', declaredLosses: []}`, and an empty array claims nothing was dropped, so
  // that value would tell the caller a summary is the verbatim conversation. Naming the kind
  // subsumes non-emptiness; a bare `.min(1)` would admit a degraded result declaring some other
  // loss while hiding the summarization. `applied` keeps full latitude over every other kind,
  // empty list included. (`.superRefine()` returns `this`, so the envelope stays a `ZodObject` and
  // the annotation above holds.)
  //
  // The inverse rule makes the kind an exact witness of the arm: `applied` with
  // `conversation_history_summarized` claims both that native replay landed and that a summary
  // stood in, so a consumer reading `status` and one reading the kind would publish opposite
  // continuity for the same value.
  .superRefine((result, ctx) => {
    if (
      result.status === "degraded" &&
      !result.declaredLosses.includes("conversation_history_summarized")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredLosses"],
        message:
          "a replay reported 'degraded' settled on the memo projection, so its declared-loss list must include 'conversation_history_summarized'; this result reports 'degraded' without it.",
      });
    }
    if (
      result.status === "applied" &&
      result.declaredLosses.includes("conversation_history_summarized")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredLosses"],
        message:
          "'conversation_history_summarized' names the memo projection standing in for the conversation, which is the 'degraded' settlement; an 'applied' replay cannot declare it, and this result reports 'applied' with it.",
      });
    }
  });

// ---- Compaction and provider commands ----

// Their params are daemon-constructed and binding-addressed: a run has many bindings and each
// operation acts on exactly one leg. The client-facing verbs take a run (compaction) or an agent
// (enumeration), and the SDK seam resolves the binding at dispatch.

/** Params of `compactContext` (gated on `context_compaction`); addresses one binding. */
export interface CompactContextParams {
  sessionId: SessionId;
  bindingId: string;
}

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

/** Params of `listProviderCommands` (gated on `provider_commands`); addresses one binding. */
export interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

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
  binding: { driverName: string; providerAccountId: string | null };
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
        driverName: z.string().min(1),
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
  binding: { driverName: string; providerAccountId: string | null };
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
