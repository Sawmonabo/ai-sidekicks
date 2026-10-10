// The pane layout's persisted grammar: what a saved layout looks like, and what a restore
// refuses to believe. Pure: encoding takes a state and returns a record, decoding takes an
// unknown and returns panes plus refusals, so tests can use hand-written records.
//
// Restore rules:
//   - A snapshot of an unknown version is discarded whole; a half-restored layout hides which
//     half is missing.
//   - An unknown pane kind is dropped and reported as a typed refusal.
//   - One pane per kind: a second pane of a kind is dropped during decoding, first in position
//     order winning, and reported; it would otherwise be written back on every save.
//
// Drops are refusals rather than tripwires, which throw in development and are for defects; a
// snapshot from an older build is expected input. The session screen records them in the
// window's diagnostic capture.

import { isRefusal, refuse, type NarrowedRefusal } from "#renderer/lib/refusal/contract.js";
import { isWireRecord } from "#renderer/lib/wire/record.js";
import { isBlockPaneKind, type BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import { parsePaneAddress } from "#renderer/routing/panes/parse-address.js";
import {
  encodePaneEntity,
  readPaneEntityCandidate,
} from "#renderer/routing/panes/entity-record.js";
import {
  DEFAULT_PANE_BLOCK_SIDE,
  DEFAULT_TERMINAL_PLACE,
  type PaneBlockSide,
  type PaneLayoutState,
  type SessionPane,
  type TerminalPlace,
} from "./state.js";

/**
 * The snapshot grammar's version. Bump it whenever a member's meaning changes; a restore of any
 * other value discards the whole record.
 */
export const PANE_LAYOUT_SNAPSHOT_VERSION = 2;

/**
 * The reserved snapshot key carrying the record's header. The `$` prefix is admitted by the
 * persistence identifier charset and no pane id starts with it, so the two never collide.
 */
export const PANE_LAYOUT_SNAPSHOT_HEADER_KEY = "$paneLayout";

/**
 * The record shape stored under the `layout` value class: an object of objects whose members are
 * numbers, booleans and identifier-shaped strings. That is the store's constraint; a nested array
 * of panes would be refused at the write.
 */
export type PaneLayoutSnapshotRecord = Record<string, Record<string, number | boolean | string>>;

/** Why a restore dropped something. */
export const PANE_LAYOUT_RESTORE_REFUSAL_CODES = [
  "snapshot-shape-invalid",
  "snapshot-version-unknown",
  "pane-shape-invalid",
  "pane-kind-unknown",
  "pane-entity-invalid",
  "pane-kind-duplicate",
] as const;

/** One restore refusal code. */
export type PaneLayoutRestoreRefusalCode = (typeof PANE_LAYOUT_RESTORE_REFUSAL_CODES)[number];

/** The origin every pane layout refusal carries, from a restore or a save. */
export const PANE_LAYOUT_REFUSAL_ORIGIN = "pane-layout";

/** The shared refusal shape, narrowed to the restore codes. */
export type PaneLayoutRestoreRefusal = NarrowedRefusal<PaneLayoutRestoreRefusalCode>;

/** What one restore did, and everything it refused. Recorded, never swallowed. */
export interface PaneLayoutRestoreReport {
  readonly restoredPaneCount: number;
  readonly refusals: readonly PaneLayoutRestoreRefusal[];
}

/** A decoded snapshot: the panes to adopt, the header's choices, and the drops. */
export interface DecodedPaneLayoutSnapshot {
  readonly panes: readonly SessionPane[];
  readonly focusedPaneId: string | undefined;
  readonly side: PaneBlockSide;
  readonly terminalPlace: TerminalPlace;
  readonly refusals: readonly PaneLayoutRestoreRefusal[];
}

/** Writes a state out: the open panes in order, the block's side and the terminal's place. */
export function encodePaneLayoutSnapshot(state: PaneLayoutState): PaneLayoutSnapshotRecord {
  const header: Record<string, number | boolean | string> = {
    version: PANE_LAYOUT_SNAPSHOT_VERSION,
    side: state.side,
    terminalPlace: state.terminalPlace,
  };
  if (state.focusedPaneId !== undefined) {
    header["focusedPaneId"] = state.focusedPaneId;
  }

  const snapshot: PaneLayoutSnapshotRecord = { [PANE_LAYOUT_SNAPSHOT_HEADER_KEY]: header };
  state.panes.forEach((pane, position) => {
    snapshot[pane.paneId] = {
      position,
      kind: pane.kind,
      ...(pane.entity === undefined ? {} : encodePaneEntity(pane.entity)),
    };
  });
  return snapshot;
}

/** Reads a snapshot back, dropping what this build cannot interpret. */
export function decodePaneLayoutSnapshot(snapshot: unknown): DecodedPaneLayoutSnapshot {
  if (!isWireRecord(snapshot)) {
    return emptyDecode(
      refusePaneLayoutRestore(
        "snapshot-shape-invalid",
        "The saved layout is not a layout record, so none of it was " +
          "restored. The session opens with no panes.",
      ),
    );
  }

  const header = snapshot[PANE_LAYOUT_SNAPSHOT_HEADER_KEY];
  if (!isWireRecord(header) || header["version"] !== PANE_LAYOUT_SNAPSHOT_VERSION) {
    // Discarded whole: a partly adopted layout hides which part went missing.
    return emptyDecode(
      refusePaneLayoutRestore(
        "snapshot-version-unknown",
        "The saved layout was written by a different version of the app, " +
          "so none of it was restored. The session opens with no panes and " +
          "saves again as you arrange them.",
      ),
    );
  }

  const refusals: PaneLayoutRestoreRefusal[] = [];
  const candidates: { readonly paneId: string; readonly entry: UnknownRecord }[] = [];
  for (const [paneId, entry] of Object.entries(snapshot)) {
    if (paneId === PANE_LAYOUT_SNAPSHOT_HEADER_KEY) {
      continue;
    }
    if (!isWireRecord(entry)) {
      refusals.push(
        refusePaneLayoutRestore(
          "pane-shape-invalid",
          "One saved pane was not a pane record and was ignored.",
        ),
      );
      continue;
    }
    candidates.push({ paneId, entry });
  }
  candidates.sort((left, right) => readPosition(left.entry) - readPosition(right.entry));

  const panes: SessionPane[] = [];
  const adoptedKinds = new Set<BlockPaneKind>();
  for (const candidate of candidates) {
    const pane = decodePane(candidate.paneId, candidate.entry, refusals);
    if (pane === undefined) {
      continue;
    }
    if (adoptedKinds.has(pane.kind)) {
      refusals.push(
        refusePaneLayoutRestore(
          "pane-kind-duplicate",
          "Two saved panes were the same kind of pane, so the second was left closed.",
        ),
      );
      continue;
    }
    adoptedKinds.add(pane.kind);
    panes.push(pane);
  }

  const focusedCandidate = header["focusedPaneId"];
  return {
    panes,
    focusedPaneId:
      typeof focusedCandidate === "string" && panes.some((pane) => pane.paneId === focusedCandidate)
        ? focusedCandidate
        : panes[0]?.paneId,
    // A member this build does not know takes the default, as a record without it would.
    side: header["side"] === "left" ? "left" : DEFAULT_PANE_BLOCK_SIDE,
    terminalPlace: header["terminalPlace"] === "above" ? "above" : DEFAULT_TERMINAL_PLACE,
    refusals,
  };
}

/** Raises a restore refusal from the closed code set. */
function refusePaneLayoutRestore(
  code: PaneLayoutRestoreRefusalCode,
  detail: string,
): PaneLayoutRestoreRefusal {
  return refuse(PANE_LAYOUT_REFUSAL_ORIGIN, code, detail);
}

function emptyDecode(refusal: PaneLayoutRestoreRefusal): DecodedPaneLayoutSnapshot {
  return {
    panes: [],
    focusedPaneId: undefined,
    side: DEFAULT_PANE_BLOCK_SIDE,
    terminalPlace: DEFAULT_TERMINAL_PLACE,
    refusals: [refusal],
  };
}

function decodePane(
  paneId: string,
  entry: UnknownRecord,
  refusals: PaneLayoutRestoreRefusal[],
): SessionPane | undefined {
  // Admission uses the one pane-address grammar. A weaker check would admit an inspector over a
  // run or an id like `bad/id`, which the pane body then refuses: an unusable pane written back
  // on every save. The transcript is the conversation's, never a pane in the block.
  const address = parsePaneAddress(entry["kind"], readPaneEntityCandidate(entry));
  if (isRefusal(address) || !isBlockPaneKind(address.kind)) {
    // Two messages cover every parse code; what a person can do about a dropped pane is the
    // same either way.
    refusals.push(
      isRefusal(address) && address.code !== "pane-kind-unknown"
        ? refusePaneLayoutRestore(
            "pane-entity-invalid",
            "One saved pane named something the app could not resolve, so it was left closed.",
          )
        : refusePaneLayoutRestore(
            "pane-kind-unknown",
            "One saved pane is a kind this version of the app does not have, " +
              "so it was left closed.",
          ),
    );
    return undefined;
  }
  return {
    paneId,
    kind: address.kind,
    entity: "entity" in address ? address.entity : undefined,
    sourcePaneId: undefined,
    returnFocusPaneId: undefined,
  };
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function readPosition(entry: UnknownRecord): number {
  const position = entry["position"];
  return typeof position === "number" && Number.isFinite(position)
    ? position
    : Number.MAX_SAFE_INTEGER;
}
