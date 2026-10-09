// The person's group verbs. Each is one write whose guards decide it, so a check and its change
// can never be split by another write; the sessions list learns of a move once it has committed.

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import {
  SESSION_GROUP_NAME_TAKEN_CODE,
  SESSION_GROUP_REFUSED_CODE,
  type SessionGroupCreateRequest,
  type SessionGroupCreateResponse,
  type SessionGroupId,
  type SessionGroupMoveRequest,
  type SessionGroupRenameRequest,
  type SessionGroupUngroupRequest,
} from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { StatementResult, WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { SessionListFeed } from "../directory/list-feed.js";
import { sessionExistsStatement } from "../directory/lookups.js";
import { sessionNotFound } from "../not-found.js";
import {
  deleteGroupStatement,
  groupExistsStatement,
  groupMembersStatement,
  groupNameFreeForRenameStatement,
  groupNameFreeInSessionProjectStatement,
  insertGroupStatement,
  leaveGroupStatement,
  projectSessionStatement,
  releaseGroupSessionsStatement,
  removeEmptyGroupsOfSessionProjectStatement,
  renameGroupStatement,
  sessionGroupPlacementStatement,
} from "./store.js";

/** What the group service needs from the daemon. */
export interface SessionGroupServiceDeps {
  readonly writer: Pick<DatabaseWriter, "write">;
  /** Told which sessions changed group, or sit in a renamed one, once each write commits. */
  readonly listFeed: Pick<SessionListFeed, "refresh">;
  readonly now?: () => Date;
}

// A guard's statement and the refusal its failure means.
interface GuardedStep {
  readonly statement: WriteStatement;
  readonly refusal?: () => Error;
}

/**
 * Places a project's sessions in named groups: a group is made with a session in it, a session
 * sits in at most one group of its project, a name is unique in its project ignoring case, and a
 * group no session sits in is removed in the write that emptied it.
 */
export class SessionGroupService {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #listFeed: Pick<SessionListFeed, "refresh">;
  readonly #now: () => Date;

  constructor(deps: SessionGroupServiceDeps) {
    this.#writer = deps.writer;
    this.#listFeed = deps.listFeed;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * Makes a group in the session's project with the session moved into it. Rejects with
   * `session.not_found`, `session.group_refused` for a chat, or
   * `session.group_name_taken` when another group of the project holds the name ignoring case.
   */
  async create(request: SessionGroupCreateRequest): Promise<SessionGroupCreateResponse> {
    const groupId = mintUuidV7() as SessionGroupId;
    const nameFolded = foldName(request.name);
    await this.#write([
      {
        statement: sessionExistsStatement(request.sessionId),
        refusal: () => sessionNotFound(request.sessionId),
      },
      {
        statement: projectSessionStatement(request.sessionId),
        refusal: () => chatHasNoGroup(request.sessionId),
      },
      {
        statement: groupNameFreeInSessionProjectStatement(request.sessionId, nameFolded),
        refusal: () => groupNameTaken(request.name),
      },
      {
        statement: insertGroupStatement({
          groupId,
          sessionId: request.sessionId,
          name: request.name,
          nameFolded,
          createdAt: this.#now().toISOString(),
        }),
      },
      { statement: sessionGroupPlacementStatement({ sessionId: request.sessionId, groupId }) },
      { statement: removeEmptyGroupsOfSessionProjectStatement(request.sessionId) },
    ]);
    this.#listFeed.refresh([request.sessionId]);
    return { groupId };
  }

  /**
   * Moves the session into a group of its own project, or out of any group with `groupId`
   * `null`. Rejects with `session.not_found`, or `session.group_refused` for a chat or a
   * group that is not in the session's project.
   */
  async move(request: SessionGroupMoveRequest): Promise<void> {
    const placement: GuardedStep =
      request.groupId === null
        ? { statement: leaveGroupStatement(request.sessionId) }
        : {
            statement: sessionGroupPlacementStatement({
              sessionId: request.sessionId,
              groupId: request.groupId,
            }),
            refusal: () =>
              new DaemonDomainError("The session cannot sit in that group.", {
                code: SESSION_GROUP_REFUSED_CODE,
                detail: { sessionId: request.sessionId, groupId: request.groupId },
              }),
          };
    await this.#write([
      {
        statement: sessionExistsStatement(request.sessionId),
        refusal: () => sessionNotFound(request.sessionId),
      },
      placement,
      { statement: removeEmptyGroupsOfSessionProjectStatement(request.sessionId) },
    ]);
    this.#listFeed.refresh([request.sessionId]);
  }

  /**
   * Renames a group, and the list then shows the new name on every session in it. Rejects with
   * `session.group_name_taken` when another group of its project holds the name ignoring case,
   * and `session.group_refused` when the group no longer exists.
   */
  async rename(request: SessionGroupRenameRequest): Promise<void> {
    const nameFolded = foldName(request.name);
    const results = await this.#write([
      {
        statement: groupExistsStatement(request.groupId),
        refusal: () =>
          new DaemonDomainError("That group no longer exists.", {
            code: SESSION_GROUP_REFUSED_CODE,
            detail: { groupId: request.groupId },
          }),
      },
      {
        statement: groupNameFreeForRenameStatement(request.groupId, nameFolded),
        refusal: () => groupNameTaken(request.name),
      },
      { statement: renameGroupStatement(request.groupId, request.name, nameFolded) },
      { statement: groupMembersStatement(request.groupId) },
    ]);
    this.#listFeed.refresh(sessionIdsOf(results.at(-1)));
  }

  /** Puts the group's sessions back loose and removes the group; a group already gone is done. */
  async ungroup(request: SessionGroupUngroupRequest): Promise<void> {
    const [released] = await this.#write([
      { statement: releaseGroupSessionsStatement(request.groupId) },
      { statement: deleteGroupStatement(request.groupId) },
    ]);
    this.#listFeed.refresh(sessionIdsOf(released));
  }

  async #write(steps: readonly GuardedStep[]): ReturnType<DatabaseWriter["write"]> {
    try {
      return await this.#writer.write(steps.map((step) => step.statement));
    } catch (error) {
      const refusal =
        error instanceof WriteRefusedError ? steps[error.statementIndex]?.refusal : undefined;
      if (refusal !== undefined) {
        throw refusal();
      }
      throw error;
    }
  }
}

// The session ids a statement selecting `id` from `sessions` answered.
function sessionIdsOf(result: StatementResult | undefined): SessionId[] {
  return ((result?.rows ?? []) as readonly { readonly id: SessionId }[]).map((row) => row.id);
}

function chatHasNoGroup(sessionId: SessionId): Error {
  return new DaemonDomainError("A chat sits in no group.", {
    code: SESSION_GROUP_REFUSED_CODE,
    detail: { sessionId },
  });
}

function groupNameTaken(name: string): Error {
  return new DaemonDomainError(`Another group of this project is already named ${name}.`, {
    code: SESSION_GROUP_NAME_TAKEN_CODE,
  });
}
