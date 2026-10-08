// The session directory row: one table says what each event type changes, and it is read two
// ways, as a fold over stored events for a rebuild and as the statements that apply the same
// change inside the event's own write, so the `sessions` row and a rebuild cannot drift.

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { UserMessagePayload } from "@ai-sidekicks/contracts/run/queue";
import type {
  SessionCreatedPayload,
  SessionMarkChangePayload,
  SessionRenamedPayload,
} from "@ai-sidekicks/contracts/session/events";
import { SESSION_NAME_MAX_LEN } from "@ai-sidekicks/contracts/session/name";
import type { SessionBranchChangedPayload } from "@ai-sidekicks/contracts/worktree/events";

import type { WriteStatement } from "../../database/statement.js";
import { normalizeOccurredAt } from "../../events/canonicalizer.js";
import type { SessionDirectoryRow, StoredEvent } from "../records.js";
import { RUN_OUTCOME_BY_EVENT_TYPE } from "./run-activity.js";

// The members of an event the directory reads, which a stored event and an append's unsequenced
// envelope both carry. Its payload is trusted as the append path's variant parse left it.
type DirectoryEvent = Pick<
  StoredEvent,
  "sessionId" | "occurredAt" | "category" | "type" | "payload"
>;

// Each event-derived `sessions` column an event writes on its own, by its row field.
const COLUMN_BY_FIELD = {
  shape: "shape",
  state: "state",
  name: "name",
  firstMessagePreview: "first_message_preview",
  branch: "branch",
  pinnedAt: "pinned_at",
  mutedAt: "muted_at",
  lastRunOutcome: "last_run_outcome",
} as const satisfies Partial<Record<keyof SessionDirectoryRow, string>>;

type ColumnField = keyof typeof COLUMN_BY_FIELD;

// `keepsFirst` writes the value only while the column is empty, so a repeat keeps the first.
type ColumnWrite = {
  readonly [Field in ColumnField]: {
    readonly kind: "column";
    readonly field: Field;
    readonly value: SessionDirectoryRow[Field];
    readonly keepsFirst: boolean;
  };
}[ColumnField];

type DirectoryChange =
  | {
      readonly kind: "create";
      readonly shape: SessionDirectoryRow["shape"];
      readonly scratchForDefinitionId: string | null;
      readonly parentSessionId: string | null;
    }
  | ColumnWrite;

type ChangeBuilder = (payload: Readonly<Record<string, unknown>>) => DirectoryChange;

function setColumn<Field extends ColumnField>(
  field: Field,
  value: SessionDirectoryRow[Field],
): DirectoryChange {
  return { kind: "column", field, value, keepsFirst: false } as ColumnWrite;
}

function keepFirstColumn<Field extends ColumnField>(
  field: Field,
  value: SessionDirectoryRow[Field],
): DirectoryChange {
  return { kind: "column", field, value, keepsFirst: true } as ColumnWrite;
}

// A payload the append path parsed against its registered variant, read as that variant.
function payloadAs<Payload>(payload: Readonly<Record<string, unknown>>): Payload {
  return payload as unknown as Payload;
}

const SESSION_CHANGE_BY_EVENT_TYPE = {
  "session.created": (payload) => {
    const created = payloadAs<SessionCreatedPayload>(payload);
    return {
      kind: "create",
      shape: created.shape,
      scratchForDefinitionId: created.scratchForDefinitionId ?? null,
      parentSessionId: created.parent?.sessionId ?? null,
    };
  },
  "session.activated": () => setColumn("state", "active"),
  "session.archived": () => setColumn("state", "archived"),
  "session.reactivated": () => setColumn("state", "active"),
  "session.closed": () => setColumn("state", "closed"),
  "session.renamed": (payload) => setColumn("name", payloadAs<SessionRenamedPayload>(payload).name),
  "session.pinned": (payload) => keepFirstColumn("pinnedAt", markTimeOf(payload)),
  "session.unpinned": () => setColumn("pinnedAt", null),
  "session.muted": (payload) => keepFirstColumn("mutedAt", markTimeOf(payload)),
  "session.unmuted": () => setColumn("mutedAt", null),
  "session.converted": () => setColumn("shape", "project"),
  "session.branch_changed": (payload) =>
    setColumn("branch", payloadAs<SessionBranchChangedPayload>(payload).branch),
  "user.message": (payload) =>
    keepFirstColumn(
      "firstMessagePreview",
      firstMessagePreviewOf(payloadAs<UserMessagePayload>(payload).message),
    ),
} as const satisfies Partial<Record<SessionEventType, ChangeBuilder>>;

// Both tables merged, keyed by the stored type string; a Map so an untrusted type cannot reach
// the prototype chain.
const CHANGE_BY_EVENT_TYPE: ReadonlyMap<string, (event: DirectoryEvent) => DirectoryChange> =
  new Map<string, (event: DirectoryEvent) => DirectoryChange>([
    ...Object.entries(SESSION_CHANGE_BY_EVENT_TYPE).map(
      ([type, build]) =>
        [type, (event: DirectoryEvent) => (build as ChangeBuilder)(event.payload)] as const,
    ),
    ...Object.entries(RUN_OUTCOME_BY_EVENT_TYPE).map(
      ([type, outcomeOf]) =>
        [
          type,
          (event: DirectoryEvent) => setColumn("lastRunOutcome", outcomeOf(event.payload)),
        ] as const,
    ),
  ]);

// Mark times sort pinned sessions, so they are stored in the one form that sorts as text.
function markTimeOf(payload: Readonly<Record<string, unknown>>): string {
  return normalizeOccurredAt(payloadAs<SessionMarkChangePayload>(payload).at);
}

/**
 * The row's preview of a message: its opening, leading whitespace dropped, cut to the session
 * name's bound in UTF-16 units without splitting a surrogate pair. A message of only whitespace
 * has none, so the next message's opening becomes the preview.
 */
function firstMessagePreviewOf(message: string): string | null {
  const opening = message.trimStart();
  if (opening.length === 0) return null;
  if (opening.length <= SESSION_NAME_MAX_LEN) return opening;
  const lastUnit = opening.charCodeAt(SESSION_NAME_MAX_LEN - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return opening.slice(0, splitsPair ? SESSION_NAME_MAX_LEN - 1 : SESSION_NAME_MAX_LEN);
}

interface DirectoryUpdate {
  readonly change: DirectoryChange | undefined;
  readonly occurredAt: string;
  readonly movesLastActivity: boolean;
  readonly movesUpdatedAt: boolean;
}

// Maintenance events are the log's own bookkeeping, and a thinking update may be dropped by a
// full write queue, so neither can say when the session was last active.
function describeDirectoryUpdate(event: DirectoryEvent): DirectoryUpdate {
  return {
    change: CHANGE_BY_EVENT_TYPE.get(event.type)?.(event),
    occurredAt: normalizeOccurredAt(event.occurredAt),
    movesLastActivity:
      event.category !== "event_maintenance" && event.type !== "assistant.thinking_update",
    movesUpdatedAt: event.category === "session_lifecycle",
  };
}

function laterOf(current: string, candidate: string): string {
  return candidate > current ? candidate : current;
}

/**
 * Opens a session's directory row from its `session.created` event. Throws for any other type,
 * since a row exists only from its session's creation.
 */
export function openDirectoryRow(created: DirectoryEvent): SessionDirectoryRow {
  const { change, occurredAt } = describeDirectoryUpdate(created);
  if (change?.kind !== "create") {
    throw new Error(`A session's directory row opens only at session.created, not ${created.type}`);
  }
  return {
    sessionId: created.sessionId,
    shape: change.shape,
    state: "provisioning",
    name: null,
    firstMessagePreview: null,
    branch: null,
    pinnedAt: null,
    mutedAt: null,
    scratchForDefinitionId: change.scratchForDefinitionId,
    parentSessionId: change.parentSessionId,
    lastRunOutcome: "idle",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    lastActivityAt: occurredAt,
  };
}

/**
 * Applies one later event to a directory row and returns the new row without mutating the input.
 * Throws for a second `session.created`, which would replace the session mid-stream.
 */
export function foldDirectoryRow(
  row: SessionDirectoryRow,
  event: DirectoryEvent,
): SessionDirectoryRow {
  const { change, occurredAt, movesLastActivity, movesUpdatedAt } = describeDirectoryUpdate(event);
  let next: SessionDirectoryRow = row;
  if (change?.kind === "create") {
    throw new Error(`session.created opens session ${row.sessionId} once and is never folded in`);
  }
  if (change?.kind === "column") {
    const current = row[change.field];
    next = {
      ...row,
      [change.field]: change.keepsFirst && current !== null ? current : change.value,
    };
  }
  return {
    ...next,
    lastActivityAt: movesLastActivity
      ? laterOf(next.lastActivityAt, occurredAt)
      : next.lastActivityAt,
    updatedAt: movesUpdatedAt ? laterOf(next.updatedAt, occurredAt) : next.updatedAt,
  };
}

/**
 * The statements that apply one event's change to the `sessions` row, run in the event's own
 * write before its row. Each is relative to the event alone. The update expects its one row, so
 * an event for a session with no row refuses the write; an event of the machine's own sentinel
 * session has none and gets no statements.
 */
export function directoryStatementsFor(event: DirectoryEvent): WriteStatement[] {
  if (event.sessionId === DAEMON_SCOPE_SENTINEL_SESSION_ID) return [];
  const { change, occurredAt, movesLastActivity, movesUpdatedAt } = describeDirectoryUpdate(event);
  if (change?.kind === "create") {
    return [
      {
        sql: `INSERT INTO sessions
                (id, shape, state, scratch_for_definition_id, parent_session_id,
                 created_at, updated_at, last_activity_at)
              VALUES (?, ?, 'provisioning', ?, ?, ?, ?, ?)`,
        bindings: [
          event.sessionId,
          change.shape,
          change.scratchForDefinitionId,
          change.parentSessionId,
          occurredAt,
          occurredAt,
          occurredAt,
        ],
      },
    ];
  }
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (change?.kind === "column") {
    const column = COLUMN_BY_FIELD[change.field];
    assignments.push(change.keepsFirst ? `${column} = COALESCE(${column}, ?)` : `${column} = ?`);
    values.push(change.value);
  }
  if (movesLastActivity) {
    assignments.push("last_activity_at = max(last_activity_at, ?)");
    values.push(occurredAt);
  }
  if (movesUpdatedAt) {
    assignments.push("updated_at = max(updated_at, ?)");
    values.push(occurredAt);
  }
  if (assignments.length === 0) return [];
  return [
    {
      sql: `UPDATE sessions SET ${assignments.join(", ")} WHERE id = ?`,
      bindings: [...values, event.sessionId],
      expectedRowCount: 1,
    },
  ];
}
