// A session's asks as the card reads them, pending and answered alike, read straight from this
// machine's approval tables. What the card shows beyond the row, the subject its standing allow
// names, the provider's own reason and the answers it may offer, is derived here from the ask as it
// was raised, never stored apart and never read from the log. A session the daemon holds no ask for
// reads as none.

import { stripVTControlCharacters } from "node:util";

import type { Database } from "better-sqlite3";

import type {
  ApprovalProjectionReadRequest,
  ApprovalProjectionReadResponse,
  ApprovalProjectionRow,
} from "@ai-sidekicks/contracts/approval";

import { ApprovalRequestReader, type StoredApprovalRequest } from "../store.js";

// Every control character left once the escape sequences are gone, a line break among them.
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/** Reads one session's asks for the `approval.projectionRead` handler. */
export class ApprovalProjectionService {
  readonly #requests: ApprovalRequestReader;

  constructor(reader: Database) {
    this.#requests = new ApprovalRequestReader(reader);
  }

  /** The session's asks, oldest first, narrowed by state or category where the request names it. */
  read(request: ApprovalProjectionReadRequest): ApprovalProjectionReadResponse {
    return { approvals: this.#requests.listSessionRequests(request).map(projectionRowOf) };
  }
}

function projectionRowOf(stored: StoredApprovalRequest): ApprovalProjectionRow {
  const reason = reasonOf(stored.resourceDescriptor.prompt);
  const row: ApprovalProjectionRow = {
    id: stored.approvalRequestId,
    runId: stored.runId,
    requestedBy: stored.requestedBy,
    category: stored.category,
    scope: stored.scope,
    resourceDescriptor: stored.resourceDescriptor,
    subject: stored.resourceDescriptor.subject,
    ...(reason === undefined ? {} : { reason }),
    standingAllowOffered: stored.standingAllowOffered,
    projectScopeOffered: stored.projectScopeOffered,
    state: stored.state,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  const { resolution } = stored;
  if (resolution === undefined) {
    return row;
  }
  return {
    ...row,
    resolvedAt: resolution.resolvedAt,
    decision: resolution.decision,
    deviceId: resolution.deviceId,
    effectiveScope: resolution.effectiveScope,
    ...(resolution.rememberedScope === undefined
      ? {}
      : { rememberedScope: resolution.rememberedScope }),
  };
}

// The provider's own line with its escape sequences and control characters taken out, so it
// cannot move the card's cursor or color it; absent where nothing readable is left.
function reasonOf(prompt: string | undefined): string | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  const readable = stripVTControlCharacters(prompt).replace(CONTROL_CHARACTERS, " ").trim();
  return readable === "" ? undefined : readable;
}
