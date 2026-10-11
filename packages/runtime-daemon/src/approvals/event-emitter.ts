// The one place the `approval.*` events are built: one emit per moment of an ask's life and of a
// rule's, each appended through the session's log with the rows it settles in the same write. The
// append parses each payload as its own type's strict variant before anything is written, so an
// under-filled payload never reaches the log. Every approval event names no actor: the daemon
// records it, and the answering device rides the resolution's own payload.

import type {
  ApprovalCanceledPayload,
  ApprovalDecision,
  ApprovalDenialOverriddenPayload,
  ApprovalRememberedPayload,
  ApprovalRequestedPayload,
  ApprovalResolvedPayload,
  ApprovalReviewerDeniedPayload,
  ApprovalRuleRevokedPayload,
} from "@ai-sidekicks/contracts/approval";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import type { WriteStatement } from "../database/statement.js";
import {
  SessionEventAppender,
  type AppendedPayload,
  type SessionEventLog,
} from "../events/session/appender.js";

/**
 * When one approval event happened, and the rows written with it: each row's own time is this
 * instant, so a rebuild from the log writes the same rows.
 */
interface ApprovalEventWrite {
  readonly occurredAt: string;
  readonly statements?: readonly WriteStatement[] | undefined;
}

const APPROVAL_EVENT_VERSION = EventEnvelopeVersionSchema.parse("1.0");

// The event each decision records.
const RESOLVED_EVENT_TYPE = {
  approved: "approval.approved",
  rejected: "approval.rejected",
} as const satisfies Record<ApprovalDecision, string>;

/** Appends the `approval.*` events, each with its rows in its own write. */
export class ApprovalEventEmitter {
  readonly #appender: SessionEventAppender;

  constructor(sessionEvents: SessionEventLog) {
    this.#appender = new SessionEventAppender({ sessionEvents }, APPROVAL_EVENT_VERSION);
  }

  /** Records a new ask. */
  async requested(payload: ApprovalRequestedPayload, write: ApprovalEventWrite): Promise<void> {
    await this.#append("approval.requested", payload, write);
  }

  /** Records an ask's answer as `approval.approved` or `approval.rejected`. */
  async resolved(
    decision: ApprovalDecision,
    payload: ApprovalResolvedPayload,
    write: ApprovalEventWrite,
  ): Promise<void> {
    await this.#append(RESOLVED_EVENT_TYPE[decision], payload, write);
  }

  /** Records an ask canceled with its run, its session or its provider process. */
  async canceled(payload: ApprovalCanceledPayload, write: ApprovalEventWrite): Promise<void> {
    await this.#append("approval.canceled", payload, write);
  }

  /**
   * Records the rule an answer handed to its provider.
   *
   * @consumedBy the rule handover to the provider that keeps it
   */
  async remembered(payload: ApprovalRememberedPayload, write: ApprovalEventWrite): Promise<void> {
    await this.#append("approval.remembered", payload, write);
  }

  /**
   * Records the end of a rule, with what ended it.
   *
   * @consumedBy the rule revocation, the session-close end of a session's rules and a tool server's
   * removal
   */
  async ruleRevoked(payload: ApprovalRuleRevokedPayload, write: ApprovalEventWrite): Promise<void> {
    await this.#append("approval.rule_revoked", payload, write);
  }

  /**
   * Records a block by the provider's own reviewer, with the provider's own record of it as the
   * row's visible body, cut short past the content bound like any body.
   *
   * @consumedBy the reviewer blocks the drivers hand over
   */
  async reviewerDenied(
    payload: ApprovalReviewerDeniedPayload,
    providerDenialBody: string,
    write: ApprovalEventWrite,
  ): Promise<void> {
    await this.#appender.append("approval.reviewer_denied", payload, {
      occurredAt: write.occurredAt,
      transactionalPrelude: write.statements,
      content: { body: providerDenialBody },
    });
  }

  /**
   * Records that a person allowed a blocked action once.
   *
   * @consumedBy the `Allow once` on a reviewer's block
   */
  async denialOverridden(
    payload: ApprovalDenialOverriddenPayload,
    occurredAt: string,
  ): Promise<void> {
    await this.#append("approval.denial_overridden", payload, { occurredAt });
  }

  async #append(
    type: SessionEventType,
    payload: AppendedPayload,
    write: ApprovalEventWrite,
  ): Promise<void> {
    await this.#appender.append(type, payload, {
      occurredAt: write.occurredAt,
      transactionalPrelude: write.statements,
    });
  }
}
