// Golden vector: the Codex `ServerNotification` methods the pinned reference records by name.
// Pin: codex-cli 0.150.1, from the generated schema (`codex app-server generate-json-schema`).
//
// This is not the full `ServerNotification` union (79 arms at the pin; only a subset is named), and
// the missing arms are not invented. A test may assert that every row here resolves as expected,
// but not that the normalizer covers the whole Codex notification surface. These are method
// vectors, not payload vectors: the reference reproduces no notification payload body.
//
// Do not hand-edit a method string to make a test pass.

/** One row of the recorded `ServerNotification` method census. */
export interface CodexServerNotificationMethodVector {
  /** The JSON-RPC `method` string, verbatim from the reference. */
  readonly method: string;
  /**
   * `true` for the 23 notifications the reference marks experimental. They are in the default
   * generated schema, but the transport drops them for a connection that did not set
   * `experimentalApi`.
   */
  readonly experimentalGatedAtPin: boolean;
  /**
   * `false` for `rawResponse/completed` and `rawResponseItem/completed`: declared upstream but
   * absent from the pinned generated schema, so the normalizer deliberately does not map them.
   */
  readonly presentInPinnedGeneratedSchema: boolean;
  /** The reference subsection the row is read from. */
  readonly referenceSection: string;
}

/**
 * Every Codex server notification the reference records by name at `codex-cli 0.150.1`, grouped
 * by the reference's own sections.
 */
export const CODEX_SERVER_NOTIFICATION_METHOD_VECTORS: readonly CodexServerNotificationMethodVector[] =
  Object.freeze([
    // Legacy bare camelCase names, no slash.
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

    // Experimental-gated: the eleven `thread/realtime/*` names, then the twelve others below.
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
      method: "thread/realtime/item/started",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/item/transcript/delta",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "thread/realtime/*",
    },
    {
      method: "thread/realtime/item/completed",
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

    // Negative controls: absent from the pinned schema, so the normalizer must not map them.
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

    // Goal notifications.
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

    // Ungated notifications recorded in the reference's adjacent-facts section. The related client
    // requests (`account/rateLimits/read`, `thread/compact/start`,
    // `thread/approveGuardianDeniedAction`) are not notifications and are absent here.
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

    // Gated, and counted in the 23 above.
    {
      method: "mcpServer/event/stream/notification",
      experimentalGatedAtPin: true,
      presentInPinnedGeneratedSchema: true,
      referenceSection: "Adjacent currency facts",
    },
  ] as const satisfies readonly CodexServerNotificationMethodVector[]);

/**
 * The gated-notification count at the pin: 23 of the 79 default-generated notifications. It is a
 * total, not a floor (both upstream marker sources were re-checked), so tests assert equality.
 */
export const CODEX_GATED_SERVER_NOTIFICATION_COUNT_AT_PIN = 23;

/**
 * The full `ServerNotification` arity at the pin. The vector list is a strict subset of it, so a
 * test must not treat that list as the whole surface.
 */
export const CODEX_SERVER_NOTIFICATION_COUNT_AT_PIN = 79;
