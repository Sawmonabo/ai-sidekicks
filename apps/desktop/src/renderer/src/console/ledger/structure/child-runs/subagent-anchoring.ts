// Where a subagent's rows hang — the anchor, and the three ways it must not move.
//
// A provider-attributed subagent is keyed by the triple `(runId, provider,
// subagentId)`, and the ledger draws that child's activity
// against ONE row: the row that launched it. That anchor has to be reference-stable,
// because everything above it is keyed on it — the thread the feed draws, the card
// the frame memoizes, and the position a reader is holding while the log grows under
// them. An anchor that moved would move the card with it.
//
// THREE WAYS IT WOULD MOVE, AND EACH IS A RULE HERE RATHER THAN A HABIT AT A CALL
// SITE. Every one of them is a LATER row that names an identity already anchored:
//
//   • **Completion is first-wins.** A subagent that completes twice — a retry, a
//     redelivery, a replayed window — anchors to the first completion the window
//     carries and never to the newest. Taking the newest would walk the card down the
//     log every time the daemon re-sent a terminal.
//   • **A resumed child re-anchors to its original launch.** A resume is not a second
//     launch: the same identity is continuing, so the anchor stays the row that
//     started it. Anchoring to the resume row would file the child's whole history
//     under a row that arrived after most of it.
//   • **A compaction inside the child re-anchors across itself.** `usage.context_
//     compacted` is a boundary in the child's own transcript and says nothing about
//     where the child began, so it never becomes an anchor.
//
// All three fall out of ONE rule stated once: the FIRST row naming an identity is that
// identity's anchor, and no later row replaces it. That is why this module is a fold
// rather than a set of branches — the three cases above are the three ways a
// last-wins fold would have been wrong, and none of them is reachable from a
// first-wins one.
//
// IDENTITY IS READ, NEVER INFERRED. A row that does not name a `subagentId` is not a
// subagent row, whatever its type: guessing one from the actor would collapse two
// concurrent subagents of one provider onto a single anchor and draw both children's
// work against one row.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { readWireString } from "../../../core/index.js";
import { projectedPayload } from "../../cards/wire-payload.js";

/** One provider-attributed subagent, keyed as `Spec-016` keys it. */
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
 * The subagent anchors over one loaded window.
 *
 * A class for the reason every other index in this directory is one: it is asked per
 * row per frame and derived once per window.
 */
export class SubagentAnchorIndex {
  readonly #rows: readonly TimelineRow[];
  #anchors: ReadonlyMap<string, SubagentAnchor> | undefined;
  #anchorsByRowId: ReadonlyMap<string, SubagentAnchor> | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Every anchor, keyed by its identity's key, in first-appearance order. */
  public anchors(): ReadonlyMap<string, SubagentAnchor> {
    this.#anchors ??= deriveSubagentAnchors(this.#rows);
    return this.#anchors;
  }

  /** The anchor a row belongs to, for the feed's per-row dispatch. */
  public anchorForRowId(rowId: string): SubagentAnchor | undefined {
    this.#anchorsByRowId ??= new Map(
      [...this.anchors().values()].flatMap((anchor) =>
        anchor.rowIds.map((memberRowId) => [memberRowId, anchor] as const),
      ),
    );
    return this.#anchorsByRowId.get(rowId);
  }

  /** Whether this row is the one its subagent's activity hangs from. */
  public isAnchorRow(rowId: string): boolean {
    return this.anchorForRowId(rowId)?.anchorRowId === rowId;
  }

  /**
   * Whether this row belongs to a subagent already anchored at a DIFFERENT row.
   *
   * The question a per-row treatment asks: a row that is its identity's anchor draws
   * the card, a row that names no identity draws its own, and a row that is a later
   * observation of an identity already anchored draws none — which is what keeps one
   * subagent's card in one place while its completion, its resume and its compaction
   * arrive.
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

/**
 * Derive every subagent anchor over one window.
 *
 * FIRST-WINS, stated once. The anchor is written when an identity is first seen and
 * is never written again; every later row of that identity joins `rowIds` and moves
 * nothing. The three re-anchoring hazards in this module's header are all "a later
 * row of an identity already anchored", so they are all closed by this one rule.
 */
export function deriveSubagentAnchors(
  rows: readonly TimelineRow[],
): ReadonlyMap<string, SubagentAnchor> {
  const anchorsByKey = new Map<string, { anchor: SubagentAnchor; rowIds: string[] }>();
  for (const row of rows) {
    const identity = subagentIdentityOf(row);
    if (identity === undefined) {
      continue;
    }
    const key = subagentIdentityKey(identity);
    const held = anchorsByKey.get(key);
    if (held !== undefined) {
      held.rowIds.push(row.id);
      continue;
    }
    const rowIds: string[] = [row.id];
    anchorsByKey.set(key, {
      anchor: { identity, anchorRowId: row.id, anchoredAt: row.timestamp, rowIds },
      rowIds,
    });
  }
  return new Map([...anchorsByKey].map(([key, held]) => [key, held.anchor]));
}

/**
 * The subagent a row names, or `undefined`.
 *
 * All three members are REQUIRED, and that is the fail-closed half of the identity
 * rule: a row naming a `subagentId` under no provider cannot be keyed the way
 * `Spec-016` keys one, and admitting it under a fabricated provider would merge two
 * providers' subagents that happen to share an id.
 *
 * `runId` comes off the arm rather than the payload — three of the four `TimelineRow`
 * arms carry it structurally, and the `general` arm structurally cannot, so a
 * subagent row that lost its run attribution is not re-attributed here.
 */
export function subagentIdentityOf(row: TimelineRow): SubagentIdentity | undefined {
  if (row.kind === "general" || row.kind === "legacy_stub") {
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
