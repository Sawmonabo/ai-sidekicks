// A pane's entity as the flat members a saved layout holds, and back. A layout record admits only
// numbers, booleans and identifier-shaped strings, so a workflow run's two snapshot points are
// written as scalar members beside the entity's kind and id, and read back as the candidate the
// address parse checks.

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";

import type { EntityRef } from "#renderer/lib/entity-kinds.js";
import type { WorkflowRunComparisonRef } from "./pane-address.js";

/** One pane's entity as layout record members. */
export type PaneEntityRecord = Readonly<Record<string, string | number>>;

/** Whether an entity is Review's run comparison, which carries two snapshot points. */
export function isWorkflowRunComparisonRef(entity: EntityRef): entity is WorkflowRunComparisonRef {
  return entity.kind === "workflow-run" && "from" in entity && "to" in entity;
}

/** The record members that write one pane's entity down. */
export function encodePaneEntity(entity: EntityRef): PaneEntityRecord {
  return {
    entityKind: entity.kind,
    entityId: entity.id,
    ...(isWorkflowRunComparisonRef(entity)
      ? { ...encodePoint("from", entity.from), ...encodePoint("to", entity.to) }
      : {}),
  };
}

/**
 * Gathers a record's flat entity members into the candidate the address parse reads. No kind and
 * no id is a session-scoped pane; anything partial is left for the parse to refuse.
 */
export function readPaneEntityCandidate(entry: Readonly<Record<string, unknown>>): unknown {
  const kind = entry["entityKind"];
  const id = entry["entityId"];
  if (kind === undefined && id === undefined) {
    return undefined;
  }
  return entry["fromPoint"] === undefined && entry["toPoint"] === undefined
    ? { kind, id }
    : { kind, id, from: readPointMembers(entry, "from"), to: readPointMembers(entry, "to") };
}

/** Whether two entities name the same thing in every member a layout keeps, points included. */
export function paneEntitiesAreEqual(
  left: EntityRef | undefined,
  right: EntityRef | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return JSON.stringify(encodePaneEntity(left)) === JSON.stringify(encodePaneEntity(right));
}

/**
 * One snapshot point read from an untrusted value, or `undefined` when it is not one: a
 * non-negative whole epoch, a known point, and a positive whole pause number exactly on a pause.
 */
export function readSnapshotPoint(candidate: unknown): WorkflowRunSnapshotPoint | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { epoch, point, pauseNumber } = candidate as Readonly<Record<string, unknown>>;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
    return undefined;
  }
  if (point === "pause") {
    return typeof pauseNumber === "number" && Number.isSafeInteger(pauseNumber) && pauseNumber > 0
      ? { epoch, point, pauseNumber }
      : undefined;
  }
  return (point === "start" || point === "end") && pauseNumber === undefined
    ? { epoch, point }
    : undefined;
}

function encodePoint(side: "from" | "to", point: WorkflowRunSnapshotPoint): PaneEntityRecord {
  return {
    [`${side}Epoch`]: point.epoch,
    [`${side}Point`]: point.point,
    ...(point.point === "pause" ? { [`${side}PauseNumber`]: point.pauseNumber } : {}),
  };
}

function readPointMembers(entry: Readonly<Record<string, unknown>>, side: "from" | "to"): unknown {
  const pauseNumber = entry[`${side}PauseNumber`];
  return {
    epoch: entry[`${side}Epoch`],
    point: entry[`${side}Point`],
    ...(pauseNumber === undefined ? {} : { pauseNumber }),
  };
}
