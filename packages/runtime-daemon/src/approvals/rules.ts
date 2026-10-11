// The standing rules a person's answers made. The providers keep them, and the daemon keeps no
// table of its own: each rule is the `approval.remembered` event its answer wrote, in force until
// an `approval.rule_revoked` event names it, and a rule's id is the id of the ask that made it, so
// a revoke finds its rule through that ask's row.
//
//   * A session's rules in force are its own and its project's: a project rule made in any
//     session of the same project reaches every one of them, through each provider's own rules,
//     written into every working folder of the project, and the daemon's answers to asks.
//   * A rule is recorded once its provider kept it, so the record never names a rule the provider
//     lacks; a record that fails takes it back out of the provider.
//   * One rule stands per kind, subject and action within its reach: a new one is recorded first,
//     then the one it replaces is revoked, so a failure between them leaves both standing, never
//     neither, and a block outranks an allow over the same subject.
//   * A revoke takes the rule out of force where its provider keeps it before it returns: out of
//     the project's files first for a project rule, so a failure there leaves it listed and in
//     force, then, once the record lands, out of the rules of every session it reached, each
//     provider reading them again without it. A session rule also ends with its session, and a
//     project rule leaves the providers with the purge of the session that made it.
//   * Rule writes are made one at a time, so two revokes of one rule never both land.

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
import { KeyedLock } from "../keyed-lock.js";
import type { RevokeRuleParams } from "../provider/driver/session-control.js";
import type {
  ProviderAnswerRule,
  ProviderAskAction,
  ProviderAskRule,
} from "../provider/port/permission-ask.js";
import type { SessionRulePort } from "../provider/port/session-rules.js";
import { describeRejection } from "../rejection.js";
import { sessionProjectSql } from "../session/directory/lookups.js";
import { deriveRuleSubject } from "./ask-description.js";
import { ApprovalEventEmitter } from "./event-emitter.js";
import { ApprovalRuleAlreadyRevokedError, ApprovalRuleNotFoundError } from "./refusals.js";
import { rememberedScopeStatement, type StoredApprovalRequest } from "./store.js";

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

// The sessions of the session's project, itself among them; a chat's own alone. The project is
// read once, and its sessions are found through the indexes on a mount's and a create request's
// project, each then checked to belong to the project now.
const PROJECT_SESSIONS_CTE = `WITH
  session_project(id) AS (SELECT ${sessionProjectSql("@session_id")}),
  project_sessions(id) AS (
    SELECT @session_id
    UNION SELECT candidate.id FROM (
        SELECT workspace.session_id AS id FROM repo_mounts AS mount
          JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
         WHERE mount.project_id = (SELECT id FROM session_project) AND mount.origin = 'attached'
        UNION SELECT request.session_id FROM session_create_requests AS request
         WHERE request.project_id = (SELECT id FROM session_project)) AS candidate
      JOIN sessions AS session ON session.id = candidate.id
     WHERE ${sessionProjectSql("candidate.id")} = (SELECT id FROM session_project))`;

// The rules in force on a session: its own, and its project's made in any of the project's
// sessions.
const SELECT_RULES_IN_FORCE_SQL = `${PROJECT_SESSIONS_CTE}
  SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id IN (SELECT id FROM project_sessions)
    AND (remembered.session_id = @session_id
      OR json_extract(remembered.payload, '$.rememberedScope.kind') = 'project')
    AND ${NOT_REVOKED_SQL}
  ORDER BY remembered.occurred_at, remembered.sequence`;

// The rules made in a session and revoked since, oldest first.
const SELECT_REVOKED_IN_SESSION_SQL = `SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id = @session_id
    AND NOT ${NOT_REVOKED_SQL}
  ORDER BY remembered.occurred_at, remembered.sequence`;

// The session's own rules of one kind in force: its session rules, which its end revokes, or its
// project rules, which its purge takes out of the providers.
const SELECT_OWN_RULES_SQL = `SELECT ${RULE_SELECT_LIST_SQL} ${RULE_SOURCE_SQL}
    AND remembered.session_id = @session_id
    AND json_extract(remembered.payload, '$.rememberedScope.kind') = @kind
    AND ${NOT_REVOKED_SQL}`;

// The ended sessions that still hold a session rule in force, which a start ends.
const SELECT_ENDED_SESSIONS_WITH_RULES_SQL = `SELECT DISTINCT remembered.session_id AS id
  ${RULE_SOURCE_SQL}
    AND json_extract(remembered.payload, '$.rememberedScope.kind') = 'session'
    AND remembered.session_id IN (SELECT id FROM sessions
      WHERE state IN ('closed', 'purge_requested'))
    AND ${NOT_REVOKED_SQL}`;

// A rule by its id, which is its ask's, and whether it is still in force.
const SELECT_RULE_SQL = `SELECT ${RULE_SELECT_LIST_SQL}, ${NOT_REVOKED_SQL} AS in_force
  ${RULE_SOURCE_SQL}
    AND remembered.session_id = (SELECT session_id FROM approval_requests WHERE id = @rule_id)
    AND json_extract(remembered.payload, '$.ruleId') = @rule_id`;

const SELECT_PROJECT_SESSIONS_SQL = `${PROJECT_SESSIONS_CTE} SELECT id FROM project_sessions`;

// The working folders of the session's project, each worktree's own: the live ones a rule is
// written into, or with the archived ones too, which a rule is taken out of where its file stayed.
const SELECT_PROJECT_FOLDERS_SQL = `SELECT DISTINCT workspace.fs_root AS folder
  FROM repo_mounts AS mount
  JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
  WHERE mount.project_id = ${sessionProjectSql("@session_id")}
    AND workspace.fs_root IS NOT NULL
    AND (@with_archived = 1 OR workspace.state <> 'archived')
  ORDER BY workspace.fs_root`;

const SELECT_SESSION_ENDED_SQL = `SELECT 1 FROM sessions
  WHERE id = ? AND state IN ('closed', 'purge_requested')`;

// The one key every rule write is made under.
const RULE_WRITES = "rule-writes";

/** Records, reads and revokes the rules a person's answers made. */
export class ApprovalRules implements SessionRulePort {
  readonly #deps: ApprovalRulesDeps;
  readonly #events: ApprovalEventEmitter;
  readonly #now: () => string;
  readonly #selectRulesInForce: Statement<{ session_id: SessionId }, RuleRow>;
  readonly #selectRevokedInSession: Statement<{ session_id: SessionId }, RuleRow>;
  readonly #selectOwnRules: Statement<
    { session_id: SessionId; kind: RememberedScope["kind"] },
    RuleRow
  >;
  readonly #selectEndedSessionsWithRules: Statement<[], { readonly id: SessionId }>;
  readonly #selectRule: Statement<
    { rule_id: RememberedRuleId },
    RuleRow & { readonly in_force: 0 | 1 }
  >;
  readonly #selectProjectSessions: Statement<{ session_id: SessionId }, { readonly id: SessionId }>;
  readonly #selectProjectFolders: Statement<
    { session_id: SessionId; with_archived: 0 | 1 },
    { readonly folder: string }
  >;
  readonly #selectSessionEnded: Statement<[SessionId], unknown>;
  readonly #writes = new KeyedLock<typeof RULE_WRITES>();
  // The ends of closed sessions under way, which a stop waits for.
  readonly #endings = new Set<Promise<void>>();
  #detachFromLog: (() => void) | undefined;

  constructor(deps: ApprovalRulesDeps) {
    this.#deps = deps;
    this.#events = new ApprovalEventEmitter(deps.sessionEvents);
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#selectRulesInForce = deps.reader.prepare(SELECT_RULES_IN_FORCE_SQL);
    this.#selectRevokedInSession = deps.reader.prepare(SELECT_REVOKED_IN_SESSION_SQL);
    this.#selectOwnRules = deps.reader.prepare(SELECT_OWN_RULES_SQL);
    this.#selectEndedSessionsWithRules = deps.reader.prepare(SELECT_ENDED_SESSIONS_WITH_RULES_SQL);
    this.#selectRule = deps.reader.prepare(SELECT_RULE_SQL);
    this.#selectProjectSessions = deps.reader.prepare(SELECT_PROJECT_SESSIONS_SQL);
    this.#selectProjectFolders = deps.reader.prepare(SELECT_PROJECT_FOLDERS_SQL);
    this.#selectSessionEnded = deps.reader.prepare(SELECT_SESSION_ENDED_SQL);
  }

  /**
   * Follows the log to end the session rules of every session that closes, and ends at once those
   * of sessions that closed with their rules still in force.
   */
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
    for (const { id } of this.#selectEndedSessionsWithRules.all()) {
      this.#endSessionRules(id);
    }
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
   * The working folders of the session's project a project rule is written into, each live
   * worktree's own, or with `withArchived` those of archived workspaces too; none for a chat.
   */
  readProjectFolders(sessionId: SessionId, withArchived = false): readonly string[] {
    return this.#selectProjectFolders
      .all({ session_id: sessionId, with_archived: withArchived ? 1 : 0 })
      .map(({ folder }) => folder);
  }

  /**
   * Records the rule an answer to `request` made, once its provider kept it, then revokes the
   * rules it replaces, out of the project's files first for a project one, and hands every session
   * those reached its rules again. A record that fails takes the rule back out of the providers
   * and throws what failed; a replaced rule's removal or revoke that fails throws with the new
   * rule recorded.
   */
  async record(request: StoredApprovalRequest, made: ProviderAnswerRule): Promise<void> {
    await this.#writes.run(RULE_WRITES, async () => {
      const { rule } = made;
      const replacedRows = this.#selectRulesInForce
        .all({ session_id: request.sessionId })
        .filter((row) => {
          const standing = providerRuleOf(row);
          return ruleKeyOf(standing) === ruleKeyOf(rule) && standing.kind === rule.kind;
        });
      const rememberedScope: RememberedScope = {
        kind: rule.kind,
        sense: rule.sense,
        pattern: rule.subject,
      };
      try {
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
          {
            occurredAt: this.#now(),
            statements: [rememberedScopeStatement(request.approvalRequestId, rememberedScope)],
          },
        );
      } catch (error) {
        await this.#takeBackUnrecorded(request.sessionId, rule, error);
      }
      const replaced: ProviderAskRule[] = [];
      for (const row of replacedRows) {
        const replacedRule = providerRuleOf(row);
        await this.#removeFromProjectFiles(row.session_id, replacedRule);
        await this.#recordRevoked(row, "explicit", request);
        replaced.push(replacedRule);
      }
      await this.#handOutRules(request.sessionId, replaced);
    });
  }

  /**
   * Revokes one rule where its provider keeps it, then records the revoke. Throws
   * `approval.rule_not_found` for a rule never made and `approval.rule_already_revoked` for one no
   * longer in force, and what the provider's revoke throws, with the rule left in force.
   */
  async revoke(ruleId: RememberedRuleId): Promise<RememberedRuleRevokeResponse> {
    return await this.#writes.run(RULE_WRITES, async () => {
      const row = this.#selectRule.get({ rule_id: ruleId });
      if (row === undefined) {
        throw new ApprovalRuleNotFoundError(ruleId);
      }
      if (row.in_force === 0) {
        throw new ApprovalRuleAlreadyRevokedError(ruleId);
      }
      const rule = providerRuleOf(row);
      await this.#removeFromProjectFiles(row.session_id, rule);
      const revokedAt = await this.#recordRevoked(row, "explicit", undefined);
      await this.#handOutRules(row.session_id, [rule]);
      return { ruleId, revokedAt, invalidationTrigger: "explicit" };
    });
  }

  /**
   * Takes the project rules `sessionId` made out of every working folder of its project before its
   * purge, and resolves with the hand-out that gives each other session of the project its rules
   * again once the purge has deleted the rules' records. Throws what a removal throws.
   */
  async withdrawProjectRules(sessionId: SessionId): Promise<() => Promise<void>> {
    return await this.#writes.run(RULE_WRITES, async () => {
      const rules = this.#selectOwnRules
        .all({ session_id: sessionId, kind: "project" })
        .map(providerRuleOf);
      for (const rule of rules) {
        await this.#removeFromProjectFiles(sessionId, rule);
      }
      const others = this.#selectProjectSessions
        .all({ session_id: sessionId })
        .map(({ id }) => id)
        .filter((id) => id !== sessionId);
      return async () => {
        for (const otherSessionId of others) {
          for (const rule of rules) {
            await this.#deps.revokeAtProvider({
              sessionId: otherSessionId,
              rule,
              projectFolder: undefined,
            });
          }
        }
      };
    });
  }

  // Hands every session `rules` reached from `sessionId` its rules again, each provider reading
  // them without the ones no longer in force.
  async #handOutRules(sessionId: SessionId, rules: readonly ProviderAskRule[]): Promise<void> {
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

  // A project rule lives in the files of every working folder of its project, those of archived
  // workspaces among them where the folder stayed; a session rule lives in no file.
  async #removeFromProjectFiles(makerSessionId: SessionId, rule: ProviderAskRule): Promise<void> {
    if (rule.kind !== "project") {
      return;
    }
    for (const projectFolder of this.readProjectFolders(makerSessionId, true)) {
      await this.#deps.revokeAtProvider({ sessionId: makerSessionId, rule, projectFolder });
    }
  }

  // Takes a rule its record failed to keep back out of the providers that kept it, then throws the
  // record's failure, with the take-back's beside it when that failed too.
  async #takeBackUnrecorded(
    sessionId: SessionId,
    rule: ProviderAskRule,
    recordFailure: unknown,
  ): Promise<never> {
    try {
      await this.#removeFromProjectFiles(sessionId, rule);
      await this.#handOutRules(sessionId, [rule]);
    } catch (takeBackFailure) {
      throw new AggregateError(
        [recordFailure, takeBackFailure],
        "The rule could not be recorded, nor taken back out of its provider",
        { cause: takeBackFailure },
      );
    }
    throw recordFailure;
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

  // No caller waits on an end, so its failure goes to the service log; the next start ends the
  // session's rules still in force.
  #endSessionRules(sessionId: SessionId): void {
    const ending = this.#writes
      .run(RULE_WRITES, async () => {
        for (const row of this.#selectOwnRules.all({ session_id: sessionId, kind: "session" })) {
          await this.#recordRevoked(row, "session_end", undefined);
        }
      })
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
