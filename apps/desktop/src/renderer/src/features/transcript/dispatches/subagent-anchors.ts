// Where a subagent's rows hang: a subagent is keyed by `(runId, provider, subagentId)` and its
// anchor is the first row naming that identity, so a repeated completion, a resume or a
// compaction inside the child never moves the card. Identity is read, never inferred: guessing
// it from the actor would merge concurrent subagents of one provider onto a single anchor.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";

/** One provider-attributed subagent, keyed as the orchestration contract keys it. */
export interface SubagentIdentity {
  readonly runId: string;
  readonly provider: string;
  readonly subagentId: string;
}

/** A subagent's anchor: the row its activity hangs from. */
export interface SubagentAnchor {
  readonly identity: SubagentIdentity;
  /** The FIRST row in the window that named this identity. Never replaced. */
  readonly anchorRowId: string;
  readonly anchoredAt: string;
  /** Every row naming this identity, in log order, the anchor included. */
  readonly rowIds: readonly string[];
}

/**
 * The subagent anchors over one log, asked per row per frame. Rows join one at a time, in log
 * order, so a log read a stretch at a time costs each stretch its own rows. First-wins: the anchor
 * is written when an identity is first seen, and later rows of that identity join `rowIds` and move
 * nothing.
 */
export class SubagentAnchorIndex {
  /** Each anchor and its growing row list, keyed by its identity's key, in first-appearance order. */
  readonly #heldByKey = new Map<string, { anchor: SubagentAnchor; rowIds: string[] }>();
  readonly #anchorsByRowId = new Map<string, SubagentAnchor>();

  public constructor(rows: readonly TranscriptEventRow[] = []) {
    for (const row of rows) {
      this.admit(row);
    }
  }

  /** Fold one row in, after every row admitted before it. */
  public admit(row: TranscriptEventRow): void {
    const identity = subagentIdentityOf(row);
    if (identity === undefined) {
      return;
    }
    const key = subagentIdentityKey(identity);
    const held = this.#heldByKey.get(key);
    if (held !== undefined) {
      held.rowIds.push(row.id);
      this.#anchorsByRowId.set(row.id, held.anchor);
      return;
    }
    const rowIds: string[] = [row.id];
    const anchor: SubagentAnchor = {
      identity,
      anchorRowId: row.id,
      anchoredAt: row.timestamp,
      rowIds,
    };
    this.#heldByKey.set(key, { anchor, rowIds });
    this.#anchorsByRowId.set(row.id, anchor);
  }

  /** Every anchor, keyed by its identity's key, in first-appearance order. */
  public anchors(): ReadonlyMap<string, SubagentAnchor> {
    return new Map([...this.#heldByKey].map(([key, held]) => [key, held.anchor]));
  }

  /** The anchor a row belongs to, for the feed's per-row dispatch. */
  public anchorForRowId(rowId: string): SubagentAnchor | undefined {
    return this.#anchorsByRowId.get(rowId);
  }

  /** Whether this row is the one its subagent's activity hangs from. */
  public isAnchorRow(rowId: string): boolean {
    return this.anchorForRowId(rowId)?.anchorRowId === rowId;
  }

  /**
   * Whether this row belongs to a subagent already anchored at a different row. An anchor row draws
   * the card, a row naming no identity draws its own, and a later observation draws none.
   */
  public isAnchoredElsewhere(rowId: string): boolean {
    const anchor = this.anchorForRowId(rowId);
    return anchor !== undefined && anchor.anchorRowId !== rowId;
  }
}

/** `runId`, `provider` and `subagentId` as one map key. */
export function subagentIdentityKey(identity: SubagentIdentity): string {
  return `${identity.runId} ${identity.provider} ${identity.subagentId}`;
}

/** Derive every subagent anchor over one window, for a caller that reads a log once. */
export function deriveSubagentAnchors(
  rows: readonly TranscriptEventRow[],
): ReadonlyMap<string, SubagentAnchor> {
  return new SubagentAnchorIndex(rows).anchors();
}

/**
 * The subagent a row names, or `undefined`. All three members are required: a `subagentId` under
 * no provider cannot be keyed as the contract keys one, and a fabricated provider would merge two
 * providers' subagents sharing an id. `runId` comes off the row, and a `general` row has none.
 */
export function subagentIdentityOf(row: TranscriptEventRow): SubagentIdentity | undefined {
  if (row.kind === "general") {
    return undefined;
  }
  const payload = projectedPayload(row);
  const provider = readWireString(payload["provider"]);
  const subagentId = readWireString(payload["subagentId"]);
  if (provider === undefined || subagentId === undefined) {
    return undefined;
  }
  return { runId: row.runId, provider, subagentId };
}
