// The session changes over a scratch session log, with a Claude Code driver that records each
// session it was asked to close.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderDriver } from "../../provider/driver/contract.js";
import { RuntimeBindingStore } from "../../provider/runtime-binding-store.js";
import { SessionChanges } from "../changes.js";
import { openSessionLog, type SessionLog } from "../directory/__fixtures__/session-log.js";

/** The session log, the changes over it, and what the driver was asked. */
export interface SessionChangesHarness {
  readonly log: SessionLog;
  readonly changes: SessionChanges;
  readonly runtimeBindings: RuntimeBindingStore;
  /** Every session the Claude Code driver was asked to close, in order. */
  readonly closedByDriver: SessionId[];
  /** The types of the session's events, in sequence order. */
  eventTypes(sessionId: SessionId): string[];
}

/** Opens a fresh session log with the session changes over it. */
export async function openSessionChangesHarness(): Promise<SessionChangesHarness> {
  const log = await openSessionLog();
  const runtimeBindings = new RuntimeBindingStore(log.scratch);
  const closedByDriver: SessionId[] = [];
  const claudeDriver = {
    closeSession: async ({ sessionId }: { sessionId: SessionId }) => {
      closedByDriver.push(sessionId);
    },
  } as unknown as ProviderDriver;
  const changes = new SessionChanges({
    reader: log.scratch.reader,
    events: log.eventLog,
    providers: { lookup: (driverName) => (driverName === "claude" ? claudeDriver : undefined) },
    runtimeBindings,
  });
  const selectTypes = log.scratch.reader.prepare<[string], { type: string }>(
    "SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence",
  );
  return {
    log,
    changes,
    runtimeBindings,
    closedByDriver,
    eventTypes: (sessionId) => selectTypes.all(sessionId).map((row) => row.type),
  };
}
