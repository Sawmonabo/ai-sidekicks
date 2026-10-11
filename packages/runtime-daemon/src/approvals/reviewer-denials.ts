// The blocks a provider's own reviewer makes at Reviewed, and `Allow once` on them. A block is
// recorded once, on the blocked call's own row, with the provider's own record of it as the event's
// body. The body is cut short past the content bound, so the record is also kept whole in its own
// row, which the override hands back after a restart and from any linked device. The first press
// hands that record back to the provider and is recorded; every later press is answered with the
// first one's instant and sends the provider nothing. A block raises no card and settles no ask.

import type { Database, Statement } from "better-sqlite3";

import {
  ReviewerDenialIdSchema,
  type ApprovalDenialOverrideRequest,
  type ApprovalDenialOverrideResponse,
  type ReviewerDenialId,
} from "@ai-sidekicks/contracts/approval";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionState } from "@ai-sidekicks/contracts/session/methods";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import type { SessionEventLog } from "../events/session/appender.js";
import { KeyedLock } from "../keyed-lock.js";
import type { ProviderDriver } from "../provider/driver/contract.js";
import type {
  ProviderReviewerDenial,
  ReviewerDenialPort,
} from "../provider/port/reviewer-denial.js";
import { refuseUnchangeableSession } from "../session/changes.js";
import { RunAgentReader } from "../session/run/agent.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { ApprovalEventEmitter } from "./event-emitter.js";
import { ReviewerDenialNotFoundError, ReviewerDenialNotOverridableError } from "./refusals.js";

/** What the reviewer blocks read, write and hand back to the provider. */
export interface ReviewerDenialsDeps {
  /** The read-only connection the log and the sessions are read on. */
  readonly reader: Database;
  readonly sessionEvents: SessionEventLog;
  /** The driver that runs `sessionId`, which tells its agent it may retry the blocked action. */
  readonly resolveDriver: (sessionId: SessionId) => Pick<ProviderDriver, "overrideDenial">;
  /** Source of every recorded instant (ISO 8601, millisecond precision). */
  readonly now?: () => string;
}

interface DenialKey {
  readonly session_id: SessionId;
  readonly denial_id: ReviewerDenialId;
}

// The blocked call's own row: the row its call opened, which carries the block's reason line.
const SELECT_TOOL_CALL_EVENT_SQL = `SELECT id FROM session_events
  WHERE session_id = @session_id
    AND type = 'tool.invoked'
    AND json_extract(payload, '$.toolCallId') = @tool_call_id
  ORDER BY sequence
  LIMIT 1`;

const SELECT_DENIAL_SQL = `SELECT json_extract(event.payload, '$.overridable') AS overridable,
       denial.provider_denial
  FROM session_events AS event
  JOIN reviewer_denials AS denial
    ON denial.denial_id = json_extract(event.payload, '$.denialId')
  WHERE event.session_id = @session_id
    AND event.type = 'approval.reviewer_denied'
    AND json_extract(event.payload, '$.denialId') = @denial_id`;

const INSERT_DENIAL_SQL = `INSERT INTO reviewer_denials (denial_id, session_id, provider_denial)
  VALUES (@denial_id, @session_id, @provider_denial)`;

const SELECT_OVERRIDE_SQL = `SELECT occurred_at FROM session_events
  WHERE session_id = @session_id
    AND type = 'approval.denial_overridden'
    AND json_extract(payload, '$.denialId') = @denial_id
  ORDER BY sequence
  LIMIT 1`;

const SELECT_SESSION_STATE_SQL = "SELECT state FROM sessions WHERE id = ?";

/**
 * Records each block a provider's reviewer makes and allows one once on a person's press: the port
 * the drivers hand their blocks to, and what the `approval.denialOverride` handler calls.
 */
export class ReviewerDenials implements ReviewerDenialPort {
  readonly #deps: ReviewerDenialsDeps;
  readonly #events: ApprovalEventEmitter;
  readonly #agents: RunAgentReader;
  readonly #now: () => string;
  readonly #selectToolCallEvent: Statement<
    { session_id: SessionId; tool_call_id: string },
    { readonly id: string }
  >;
  readonly #selectDenial: Statement<
    DenialKey,
    { readonly overridable: 0 | 1; readonly provider_denial: string }
  >;
  readonly #selectOverride: Statement<DenialKey, { readonly occurred_at: string }>;
  readonly #selectSessionState: Statement<[SessionId], { readonly state: SessionState }>;
  // Orders the presses on one block, so two at once hand it to the provider once.
  readonly #overrideLock: KeyedLock<ReviewerDenialId> = new KeyedLock<ReviewerDenialId>(
    canonicalizeUuid,
  );

  constructor(deps: ReviewerDenialsDeps) {
    this.#deps = deps;
    this.#events = new ApprovalEventEmitter(deps.sessionEvents);
    this.#agents = new RunAgentReader(deps.reader);
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#selectToolCallEvent = deps.reader.prepare(SELECT_TOOL_CALL_EVENT_SQL);
    this.#selectDenial = deps.reader.prepare(SELECT_DENIAL_SQL);
    this.#selectOverride = deps.reader.prepare(SELECT_OVERRIDE_SQL);
    this.#selectSessionState = deps.reader.prepare(SELECT_SESSION_STATE_SQL);
  }

  /**
   * Records one block on the blocked call's own row. Rejects when the call has no row to carry it,
   * since a block must not be recorded where no row can show it, and when the provider's record of
   * the block is not JSON.
   */
  async takeDenial(denial: ProviderReviewerDenial): Promise<void> {
    const toolCallEvent = this.#selectToolCallEvent.get({
      session_id: denial.sessionId,
      tool_call_id: denial.toolCallId,
    });
    if (toolCallEvent === undefined) {
      throw new Error(
        `The blocked tool call ${denial.toolCallId} of session ${denial.sessionId} has no row to ` +
          "carry its block",
      );
    }
    const providerDenialBody = JSON.stringify(denial.providerDenial);
    if (typeof providerDenialBody !== "string") {
      throw new TypeError("A provider's record of a block is kept as JSON");
    }
    const denialId = ReviewerDenialIdSchema.parse(mintUuidV7());
    await this.#events.reviewerDenied(
      {
        sessionId: denial.sessionId,
        runId: denial.runId,
        agentId: this.#agents.readAgent(denial.sessionId, denial.runId),
        denialId,
        eventId: toolCallEvent.id,
        reason: denial.reason,
        overridable: denial.overridable,
      },
      providerDenialBody,
      {
        occurredAt: this.#now(),
        statements: [
          {
            sql: INSERT_DENIAL_SQL,
            bindings: {
              denial_id: denialId,
              session_id: denial.sessionId,
              provider_denial: providerDenialBody,
            },
            expectedRowCount: 1,
          },
        ],
      },
    );
  }

  /**
   * Allows the blocked action once: hands the provider's own record of the block back to its
   * driver and records the override. A block already allowed is answered with the first press's
   * instant and sends nothing. Throws `approval.denial_not_found`, `approval.denial_not_overridable`,
   * and `session.already_closed` for a session that has closed.
   */
  async overrideDenial(
    request: ApprovalDenialOverrideRequest,
  ): Promise<ApprovalDenialOverrideResponse> {
    return this.#overrideLock.run(request.denialId, async () => {
      const key: DenialKey = { session_id: request.sessionId, denial_id: request.denialId };
      const denial = this.#selectDenial.get(key);
      if (denial === undefined) {
        throw new ReviewerDenialNotFoundError(request.sessionId, request.denialId);
      }
      const earlier = this.#selectOverride.get(key);
      if (earlier !== undefined) {
        return { denialId: request.denialId, overriddenAt: earlier.occurred_at };
      }
      if (denial.overridable !== 1) {
        throw new ReviewerDenialNotOverridableError(request.sessionId, request.denialId);
      }
      const session = this.#selectSessionState.get(request.sessionId);
      if (session !== undefined) {
        refuseUnchangeableSession(request.sessionId, session.state);
      }
      await this.#deps.resolveDriver(request.sessionId).overrideDenial({
        sessionId: request.sessionId,
        providerDenial: JSON.parse(denial.provider_denial) as unknown,
      });
      const overriddenAt = this.#now();
      await this.#events.denialOverridden(
        { sessionId: request.sessionId, denialId: request.denialId },
        overriddenAt,
      );
      return { denialId: request.denialId, overriddenAt };
    });
  }
}
