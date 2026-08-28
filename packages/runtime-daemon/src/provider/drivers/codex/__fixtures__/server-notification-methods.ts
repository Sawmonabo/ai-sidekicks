// GOLDEN VECTOR — Codex `ServerNotification` method census (the subset the
// pinned reference records by exact name).
//
//   Source doc      : docs/reference/provider-wire/codex.md
//   Sections        : §Method namespace (the legacy bare-camelCase residual),
//                     §The experimental gate — a runtime filter, not a schema
//                     filter (the nineteen gated notifications),
//                     §Capability shapes (`thread/goal/*`,
//                     `thread/realtime/*`), §Adjacent currency facts
//   Pin             : codex-cli 0.149.1
//   Provenance      : Generated schema (`codex app-server
//                     generate-json-schema` / `generate-ts`), regenerated
//                     2026-08-25; the experimental-marker sets additionally
//                     Upstream source at `openai/codex` `rust-v0.149.1`
//   Trust           : Verified at 0.149.1
//   Derived by      : Plan-005 T3.5
//
// COMPLETENESS — READ THIS BEFORE ASSERTING OVER THIS FILE.
//
// This is NOT the full `ServerNotification` union. codex.md records that root
// as carrying 75 arms at the pin but enumerates only a subset by name. This
// fixture carries exactly the named subset and nothing else — inventing the
// remaining arms to reach 75 is precisely the hand-transcription the family
// README forbids. So a test may assert "every row here resolves as expected"
// and "no row here is missing from the normalizer census", and may NOT assert
// "the normalizer census covers the Codex notification surface".
//
// The same payload caveat as the sibling ServerRequest fixture applies: the
// reference reproduces no notification payload body verbatim, so these are
// method census vectors, not payload golden vectors.
//
// Regeneration: re-run codex.md §Regeneration against the new binary on a pin
// move and re-derive. Do not hand-edit a method string to make a test pass.

/** One row of the recorded `ServerNotification` method census. */
export interface CodexServerNotificationMethodVector {
  /** The JSON-RPC `method` string, verbatim from the reference. */
  readonly method: string;
  /**
   * `true` for the nineteen notifications codex.md §The experimental gate
   * enumerates as carrying an `#[experimental(...)]` marker: they are present
   * in the DEFAULT-generated schema (the generator has no notification-side
   * exclusion) but the transport's `should_skip_notification_for_connection`
   * drops them for a connection that did not set `experimentalApi`.
   */
  readonly experimentalGatedAtPin: boolean;
  /**
   * `false` for the two variants the reference records as declared in the
   * upstream `server_notification_definitions!` block (77) yet ABSENT from the
   * binary's own default generation (75): `rawResponse/completed` and
   * `rawResponseItem/completed`. The generated schema is the pin, so these are
   * not members of the pinned native set — the normalizer deliberately does
   * not map them, and the test pins that as a negative control.
   */
  readonly presentInPinnedGeneratedSchema: boolean;
  /** The codex.md subsection the row is read from. */
  readonly referenceSection: string;
}

/**
 * Every Codex server notification codex.md records by exact method name at
 * `codex-cli 0.149.1`.
 *
 * Blocks below mirror the reference's own sections; within a block, rows keep
 * the reference's order so a reviewer can reconcile line by line.
 */
export const CODEX_SERVER_NOTIFICATION_METHOD_VECTORS: readonly CodexServerNotificationMethodVector[] =
  Object.freeze([
    // §Method namespace — "Legacy — bare camelCase, no slash. A small residual
    // set: ... server notifications `error`, `warning`, `configWarning`,
    // `deprecationNotice`, `guardianWarning`."
    {
      method: "error",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Method namespace",
    },
    {
      method: "warning",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Method namespace",
    },
    {
      method: "configWarning",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Method namespace",
    },
    {
      method: "deprecationNotice",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Method namespace",
    },
    {
      method: "guardianWarning",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Method namespace",
    },

    // §The experimental gate — "At `0.149.1`, 19 of the 75 default-generated
    // server notifications are gated: all eight `thread/realtime/*` (see
    // below), plus `thread/reverted`, `thread/queue/changed`,
    // `project/changed`, `thread/project/updated`,
    // `thread/environment/connected`, `thread/environment/disconnected`,
    // `thread/settings/updated`, `autoApprovalReview/strictReviewRequired`,
    // `process/outputDelta`, `process/exited`, and `turn/moderationMetadata`."
    //
    // The eight realtime names are spelled in full in codex.md
    // §`thread/realtime/*` ("`thread/realtime/started`, `.../closed`,
    // `.../error`, `.../itemAdded`, `.../sdp`, `.../outputAudio/delta`,
    // `.../transcript/delta`, `.../transcript/done`") and again, unelided, in
    // Plan-005 T3.11.
    {
      method: "thread/realtime/started",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/closed",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/error",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/itemAdded",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/sdp",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/outputAudio/delta",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/transcript/delta",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/transcript/done",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/reverted",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "thread/queue/changed",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "project/changed",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "thread/project/updated",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "thread/environment/connected",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "thread/environment/disconnected",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "thread/settings/updated",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "autoApprovalReview/strictReviewRequired",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "process/outputDelta",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "process/exited",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },
    {
      method: "turn/moderationMetadata",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "The experimental gate",
    },

    // §The experimental gate — "The two that do not reach the schema are
    // `rawResponse/completed` and `rawResponseItem/completed`". Carried as
    // negative controls: the pin says they cannot arrive, so the normalizer
    // must NOT claim a mapping for them.
    {
      method: "rawResponse/completed",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: false,
      referenceSection: "The experimental gate",
    },
    {
      method: "rawResponseItem/completed",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: false,
      referenceSection: "The experimental gate",
    },

    // §`thread/goal/*` — "the wire also emits `thread/goal/updated` and
    // `thread/goal/cleared` server notifications. All present at `0.149.1`."
    {
      method: "thread/goal/updated",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/goal/*",
    },
    {
      method: "thread/goal/cleared",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/goal/*",
    },

    // §Adjacent currency facts — "`account/rateLimits/read` (pull) +
    // `account/rateLimits/updated` (push) — rate limits are first-class";
    // "`thread/compact/start` + `thread/compacted` — compaction is
    // controllable"; "`turn/diff/updated` + `turn/plan/updated` — the per-turn
    // diff and plan snapshot notifications. Both are present in the
    // default-generated `ServerNotification` union" (those two rows alone added
    // to the reference 2026-08-28, closing the gap that had kept these two
    // delta-family members out of this census; their `experimentalGatedAtPin`
    // is `false` for this file's ONE declared reason — absence from the
    // §The experimental gate enumeration, never a gate claim read off
    // §Adjacent currency facts); "Guardian routing: `guardianWarning`,
    // `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`,
    // `thread/approveGuardianDeniedAction`"; "New at the pin and worth knowing
    // about: ... the notifications `model/safetyBuffering/updated` and
    // `thread/queue/changed`."
    //
    // `account/rateLimits/read`, `thread/compact/start` and
    // `thread/approveGuardianDeniedAction` are CLIENT requests and are
    // deliberately absent from this notification census.
    {
      method: "account/rateLimits/updated",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "thread/compacted",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "turn/diff/updated",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "turn/plan/updated",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "item/autoApprovalReview/started",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "item/autoApprovalReview/completed",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
    {
      method: "model/safetyBuffering/updated",
      experimentalGatedAtPin: false,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
  ] as const satisfies readonly CodexServerNotificationMethodVector[]);

/**
 * The gated-notification count at the pin, quoted from codex.md §The
 * experimental gate: "At `0.149.1`, 19 of the 75 default-generated server
 * notifications are gated". The reference additionally argues why 19 is a
 * TOTAL and not a floor (both `experimental_reason()` sources were checked),
 * which is what makes this safe to pin as an equality rather than a minimum.
 */
export const CODEX_GATED_SERVER_NOTIFICATION_COUNT_AT_PIN = 19;

/**
 * The full `ServerNotification` arity at the pin, quoted from codex.md
 * §Additive-only across the floor: "`ServerNotification` 66 -> 75".
 *
 * Recorded so the completeness caveat at the top of this file is a VALUE a
 * test can assert against rather than only prose: the vector list above is a
 * strict subset of this, and any test that treats it as the whole surface is
 * wrong by construction.
 */
export const CODEX_SERVER_NOTIFICATION_COUNT_AT_PIN = 75;
