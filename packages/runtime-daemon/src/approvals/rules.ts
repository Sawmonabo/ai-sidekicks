// The standing rules a person's answers made. The providers keep them, and the daemon keeps no
// table of its own: each rule is the `approval.remembered` event its answer wrote, in force until
// an `approval.rule_revoked` event names it, and a rule's id is the id of the ask that made it, so
// a revoke finds its rule through that ask's row.
//
//   * A session's rules in force are its own and its project's: a project rule made in any
//     session of the same project reaches every one of them, through each provider's own session
//     rules and the daemon's answers to asks, wherever the session works.
//   * One rule stands per kind, subject and action within its reach: a new one revokes the one it
//     replaces, so a revoke never brings an older rule back, and takes it out of force as a revoke
//     does, so a block a provider still held never outranks the allow that replaced it.
//   * A revoke takes the rule out of force where its provider keeps it before it returns: out of
//     the project's file first for a project rule, so a failure there leaves it listed and in
//     force, then, once the record lands, out of the session rules of every session it reached,
//     each provider reading the rules again without it. A session rule also ends with its session.

import type { Database, Statement } from "better-sqlite3";

import {
  RememberedRuleIdSchema,
  type ApprovalCategory,
  type ApprovalRuleRevokedPayload,
  type RememberedRule,
  type RememberedRuleId,
  type RememberedRuleListResponse,
  type RememberedRuleRevokeResponse,
  type RememberedScope,
} from "@ai-sidekicks/contracts/approval";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import type { SessionEventLog } from "../events/session/appender.js";
import type { RevokeRuleParams } from "../provider/driver/session-control.js";
import type { ProviderAskAction, ProviderAskRule } from "../provider/port/permission-ask.js";
import type { SessionRulePort } from "../provider/port/session-rules.js";
import { describeRejection } from "../rejection.js";
import { sessionProjectSql } from "../session/directory/lookups.js";
import { deriveRuleSubject } from "./ask-description.js";
import { ApprovalEventEmitter } from "./event-emitter.js";
import { ApprovalRuleAlreadyRevokedError, ApprovalRuleNotFoundError } from "./refusals.js";
import type { StoredApprovalRequest } from "./store.js";

/** What the rules read, write and hand to the providers. */
export interface ApprovalRulesDeps {
  /** The read-only connection the log and the asks are read on. */
  readonly reader: Database;
  readonly sessionEvents: SessionEventLog;
  /** The machine whose providers keep the rules made here. */
  readonly nodeId: NodeId;
  /** Follows every session's events; `onGap` names a session whose missed events went unread. */
  readonly followAll: (
    onCommitted: (event: EventEnvelope) => void,
    onGap: (sessionId: SessionId) => void,
  ) => () => void;
  /** The folder a session works in now, or `undefined` for one with no workspace ready. */
  readonly readWorkingFolder: (sessionId: SessionId) => string | undefined;
  /** Takes a revoked rule out of force at the provider of one session. */
  readonly revokeAtProvider: (revocation: RevokeRuleParams) => Promise<void>;
  readonly writeServiceLog: ServiceLogWriter;
  /** Source of every recorded instant (ISO 8601, millisecond precision). */
  readonly now?: () => string;
}

// One rule in force as the log holds it, with the action kind its ask's row names.
interface RuleRow {
  readonly session_id: SessionId;
  readonly rule_id: RememberedRuleId;
  readonly kind: RememberedScope["kind"];
  readonly sense: RememberedScope["sense"];
  readonly pattern: string;
  readonly action: ProviderAskAction["kind"];
  readonly category: ApprovalCategory;
  readonly scope: string;
  readonly granted_at: string;
}

// A rule whose ask's row still stands; a rule made on a card no provider relayed names no action
// and is not one the providers keep.
const RULE_SELECT_LIST_SQL = `remembered.session_id,
       json_extract(remembered.payload, '$.ruleId') AS rule_id,
       json_extract(remembered.payload, '$.rememberedScope.kind') AS kind,
       json_extract(remembered.payload, '$.rememberedScope.sense') AS sense,
       json_extract(remembered.payload, '$.rememberedScope.pattern') AS pattern,
       json_extract(request.resource_descriptor, '$.action.kind') AS action,
       request.category, request.scope, remembered.occurred_at AS granted_at`;
const RULE_SOURCE_SQL = `FROM session_events AS remembered
  JOIN approval_requests AS request
    ON request.id = json_extract(remembered.payload, '$.approvalRequestId')
  WHERE remembered.type = 'approval.remembered'
    AND json_valid(remembered.payload)
    AND json_extract(request.resource_descriptor, '$.action.kind') IS NOT NULL`;

const NOT_REVOKED_SQL = `NOT EXISTS (SELECT 1 FROM session_events AS revoked
    WHERE revoked.session_id = remembered.session_id
      AND revoked.type = 'approval.rule_revoked'
      AND json_valid(revoked.payload)
      AND json_extract(revoked.payload, '$.ruleId') = json_extract(remembered.payload, '$.ruleId'))`;

// The sessions of the session's project, itself among them; a chat's own alone.
const PROJECT_SESSIONS_SQL = `SELECT @session_id AS id
  UNION SELECT other.id FROM sessions AS other
   WHERE ${sessionProjectSql("other.id")} = ${sessionProjectSql("@session_id")}`;

// The rules in force on a session: its own, and its project's made in any of the project's
// sessions.
const SELECT_RULES_IN_FORCE_SQL = `SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id IN (${PROJECT_SESSIONS_SQL})
    AND (remembered.session_id = @session_id
      OR json_extract(remembered.payload, '$.rememberedScope.kind') = 'project')
    AND ${NOT_REVOKED_SQL}
  ORDER BY remembered.occurred_at, remembered.sequence`;

// The rules made in a session and revoked since, oldest first.
const SELECT_REVOKED_IN_SESSION_SQL = `SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id = @session_id
    AND NOT ${NOT_REVOKED_SQL}
  ORDER BY remembered.occurred_at, remembered.sequence`;

// The session's own rules in force, which its end revokes.
const SELECT_SESSION_RULES_SQL = `SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id = @session_id
    AND json_extract(remembered.payload, '$.rememberedScope.kind') = 'session'
    AND ${NOT_REVOKED_SQL}`;

// A rule by its id, which is its ask's, and whether it is still in force.
const SELECT_RULE_SQL = `SELECT ${RULE_SELECT_LIST_SQL}, ${NOT_REVOKED_SQL} AS in_force
  ${RULE_SOURCE_SQL}
    AND remembered.session_id = (SELECT session_id FROM approval_requests WHERE id = @rule_id)
    AND json_extract(remembered.payload, '$.ruleId') = @rule_id`;

const SELECT_PROJECT_SESSIONS_SQL = `SELECT id FROM (${PROJECT_SESSIONS_SQL})`;

const SELECT_SESSION_ENDED_SQL = `SELECT 1 FROM sessions
  WHERE id = ? AND state IN ('closed', 'purge_requested')`;

/**
 * A rule an answer made, and the rules it replaced, which the sessions they reached hold until
 * {@link ApprovalRules.handOutRules} hands those sessions their rules again.
 */
export interface RecordedRule {
  readonly rule: ProviderAskRule;
  readonly replaced: readonly ProviderAskRule[];
}

/** Records, reads and revokes the rules a person's answers made. */
export class ApprovalRules implements SessionRulePort {
  readonly #deps: ApprovalRulesDeps;
  readonly #events: ApprovalEventEmitter;
  readonly #now: () => string;
  readonly #selectRulesInForce: Statement<{ session_id: SessionId }, RuleRow>;
  readonly #selectRevokedInSession: Statement<{ session_id: SessionId }, RuleRow>;
  readonly #selectSessionRules: Statement<{ session_id: SessionId }, RuleRow>;
  readonly #selectRule: Statement<
    { rule_id: RememberedRuleId },
    RuleRow & { readonly in_force: 0 | 1 }
  >;
  readonly #selectProjectSessions: Statement<{ session_id: SessionId }, { readonly id: SessionId }>;
  readonly #selectSessionEnded: Statement<[SessionId], unknown>;
  // The ends of closed sessions under way, which a stop waits for.
  readonly #endings = new Set<Promise<void>>();
  #detachFromLog: (() => void) | undefined;

  constructor(deps: ApprovalRulesDeps) {
    this.#deps = deps;
    this.#events = new ApprovalEventEmitter(deps.sessionEvents);
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#selectRulesInForce = deps.reader.prepare(SELECT_RULES_IN_FORCE_SQL);
    this.#selectRevokedInSession = deps.reader.prepare(SELECT_REVOKED_IN_SESSION_SQL);
    this.#selectSessionRules = deps.reader.prepare(SELECT_SESSION_RULES_SQL);
    this.#selectRule = deps.reader.prepare(SELECT_RULE_SQL);
    this.#selectProjectSessions = deps.reader.prepare(SELECT_PROJECT_SESSIONS_SQL);
    this.#selectSessionEnded = deps.reader.prepare(SELECT_SESSION_ENDED_SQL);
  }

  /** Follows the log to end the session rules of every session that closes. */
  start(): void {
    this.#detachFromLog = this.#deps.followAll(
      (event) => {
        if (event.type === "session.closed") {
          this.#endSessionRules(event.sessionId);
        }
      },
      (sessionId) => {
        if (this.#selectSessionEnded.get(sessionId) !== undefined) {
          this.#endSessionRules(sessionId);
        }
      },
    );
  }

  /** Stops following the log and waits for the ends under way. */
  async stop(): Promise<void> {
    this.#detachFromLog?.();
    await Promise.all(this.#endings);
  }

  /** The rules in force on the session, its own and its project's, oldest first. */
  readSessionRules(sessionId: SessionId): readonly ProviderAskRule[] {
    return this.#selectRulesInForce.all({ session_id: sessionId }).map(providerRuleOf);
  }

  /**
   * The rule the session made over `action`'s subject and that was revoked since, when no rule in
   * force on the session covers that subject again.
   */
  findRevokedRule(sessionId: SessionId, action: ProviderAskAction): ProviderAskRule | undefined {
    const subject = deriveRuleSubject(action);
    if (subject === undefined || this.findRule(sessionId, action.kind, subject) !== undefined) {
      return undefined;
    }
    return this.#selectRevokedInSession
      .all({ session_id: sessionId })
      .map(providerRuleOf)
      .find((rule) => rule.action === action.kind && rule.subject === subject);
  }

  /**
   * The rule in force on the session over `subject` for an action of `action`'s kind, or
   * `undefined` when none is; a block over the subject outranks an allow.
   */
  findRule(
    sessionId: SessionId,
    action: ProviderAskAction["kind"],
    subject: string,
  ): ProviderAskRule | undefined {
    const matching = this.readSessionRules(sessionId).filter(
      (rule) => rule.action === action && rule.subject === subject,
    );
    return matching.find((rule) => rule.sense === "block") ?? matching[0];
  }

  /** The rules in force on the session, as the inspector lists them, oldest first. */
  list(sessionId: SessionId): RememberedRuleListResponse {
    return {
      rules: this.#selectRulesInForce.all({ session_id: sessionId }).map(
        (row): RememberedRule => ({
          ruleId: row.rule_id,
          category: row.category,
          scope: { kind: row.kind, sense: row.sense, pattern: row.pattern },
          grantedAt: row.granted_at,
        }),
      ),
    };
  }

  /**
   * Records the rule an answer to `request` made, naming the action its ask was, after revoking the
   * rules it replaces, out of the project's file first for a project one, and answers the rule as
   * its provider keeps it with the rules it replaced. Throws what the log's append or a provider's
   * file removal throws; a replaced rule's revoke that failed leaves the new rule unrecorded.
   */
  async record(
    request: StoredApprovalRequest,
    action: ProviderAskAction["kind"],
    rememberedScope: RememberedScope,
  ): Promise<RecordedRule> {
    const rule: ProviderAskRule = {
      kind: rememberedScope.kind,
      sense: rememberedScope.sense,
      action,
      subject: rememberedScope.pattern,
    };
    const replaced: ProviderAskRule[] = [];
    for (const row of this.#selectRulesInForce.all({ session_id: request.sessionId })) {
      const replacedRule = providerRuleOf(row);
      if (ruleKeyOf(replacedRule) === ruleKeyOf(rule) && replacedRule.kind === rule.kind) {
        await this.#removeFromProjectFile(row, replacedRule);
        await this.#recordRevoked(row, "explicit", request);
        replaced.push(replacedRule);
      }
    }
    await this.#events.remembered(
      {
        sessionId: request.sessionId,
        runId: request.runId,
        approvalRequestId: request.approvalRequestId,
        category: request.category,
        scope: request.scope,
        nodeId: this.#deps.nodeId,
        ruleId: RememberedRuleIdSchema.parse(request.approvalRequestId),
        rememberedScope,
      },
      { occurredAt: this.#now() },
    );
    return { rule, replaced };
  }

  /**
   * Hands every session `rules` reached from `sessionId` its rules again, each provider reading
   * them without the ones revoked since. Throws what a provider's handover throws.
   */
  async handOutRules(sessionId: SessionId, rules: readonly ProviderAskRule[]): Promise<void> {
    for (const rule of rules) {
      const reached =
        rule.kind === "project"
          ? this.#selectProjectSessions.all({ session_id: sessionId }).map(({ id }) => id)
          : [sessionId];
      for (const reachedSessionId of reached) {
        await this.#deps.revokeAtProvider({
          sessionId: reachedSessionId,
          rule,
          projectFolder: undefined,
        });
      }
    }
  }

  /**
   * Revokes one rule where its provider keeps it, then records the revoke. Throws
   * `approval.rule_not_found` for a rule never made and `approval.rule_already_revoked` for one no
   * longer in force, and what the provider's revoke throws, with the rule left in force.
   */
  async revoke(ruleId: RememberedRuleId): Promise<RememberedRuleRevokeResponse> {
    const row = this.#selectRule.get({ rule_id: ruleId });
    if (row === undefined) {
      throw new ApprovalRuleNotFoundError(ruleId);
    }
    if (row.in_force === 0) {
      throw new ApprovalRuleAlreadyRevokedError(ruleId);
    }
    const rule = providerRuleOf(row);
    await this.#removeFromProjectFile(row, rule);
    const revokedAt = await this.#recordRevoked(row, "explicit", undefined);
    await this.handOutRules(row.session_id, [rule]);
    return { ruleId, revokedAt, invalidationTrigger: "explicit" };
  }

  // A project rule lives in the file of the folder the session that made it works in; a session
  // with no folder left holds no file the rule could be in.
  async #removeFromProjectFile(row: RuleRow, rule: ProviderAskRule): Promise<void> {
    const projectFolder =
      rule.kind === "project" ? this.#deps.readWorkingFolder(row.session_id) : undefined;
    if (projectFolder !== undefined) {
      await this.#deps.revokeAtProvider({ sessionId: row.session_id, rule, projectFolder });
    }
  }

  async #recordRevoked(
    row: RuleRow,
    invalidationTrigger: ApprovalRuleRevokedPayload["invalidationTrigger"],
    replacing: StoredApprovalRequest | undefined,
  ): Promise<string> {
    const revokedAt = this.#now();
    await this.#events.ruleRevoked(
      {
        sessionId: row.session_id,
        category: row.category,
        scope: row.scope,
        ruleId: row.rule_id,
        invalidationTrigger,
        ...(replacing === undefined
          ? {}
          : { runId: replacing.runId, approvalRequestId: replacing.approvalRequestId }),
      },
      { occurredAt: revokedAt },
    );
    return revokedAt;
  }

  // No caller waits on an end, so its failure goes to the service log; the session's next close
  // follow after a restart reads its rules again through the gap read.
  #endSessionRules(sessionId: SessionId): void {
    const ending = (async () => {
      for (const row of this.#selectSessionRules.all({ session_id: sessionId })) {
        await this.#recordRevoked(row, "session_end", undefined);
      }
    })()
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `Ending the session rules of closed session ${sessionId} failed: ` +
            describeRejection(error),
        );
      })
      .finally(() => {
        this.#endings.delete(ending);
      });
    this.#endings.add(ending);
  }
}

function providerRuleOf(row: RuleRow): ProviderAskRule {
  return { kind: row.kind, sense: row.sense, action: row.action, subject: row.pattern };
}

// What one rule stands over: its action and subject, whatever its sense.
function ruleKeyOf(rule: ProviderAskRule): string {
  return `${rule.action}\u0000${rule.subject}`;
}
