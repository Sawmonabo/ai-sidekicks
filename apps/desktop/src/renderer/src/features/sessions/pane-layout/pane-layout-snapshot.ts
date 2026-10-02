// The pane layout's persisted grammar: what a saved layout looks like, and what a restore
// refuses to believe. Pure: encoding takes a state and returns a record, decoding takes an
// unknown and returns panes plus refusals, so tests can use hand-written records.
//
// Restore rules:
//   - A snapshot of an unknown version is discarded whole; a half-restored layout hides which
//     half is missing.
//   - An unknown pane kind is dropped and reported as a typed refusal.
//   - The restore count is capped, because a corrupted or hand-edited record is untrusted.
//   - One entity, one pane: a duplicate address is coalesced during decoding, first in position
//     order winning, and reported. `open()` would not repair it, and the duplicate would be
//     written back on every save.
//
// Drops are refusals rather than tripwires, which throw in development and are for defects; a
// snapshot from an older build is expected input. The session screen records them in the
// window's diagnostic capture.

import { isRefusal, refuse, type NarrowedRefusal } from "@renderer/lib/refusal.js";
import { isWireRecord } from "@renderer/lib/wire-record.js";
import { isEphemeralPaneKind, isPaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { parsePaneAddress } from "@renderer/routing/panes/parse-pane-address.js";
import { DEFAULT_PANE_LAYOUT_DENSITY, type PaneLayoutDensity } from "./pane-layout-measures.js";
import { isPaneLayoutDensity } from "./pane-layout-density.js";
import {
  PANE_LAYOUT_TOTAL_PERMILLE,
  normalize,
  paneAddressKey,
  type PaneLayoutState,
  type SessionPane,
} from "./pane-layout.js";

/**
 * The snapshot grammar's version. Bump it whenever a member's meaning changes; a restore of any
 * other value discards the whole record.
 */
export const PANE_LAYOUT_SNAPSHOT_VERSION = 1;

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
  "pane-address-duplicate",
  "restore-cap-exceeded",
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
  readonly density: PaneLayoutDensity;
  readonly refusals: readonly PaneLayoutRestoreRefusal[];
}

/** Writes a state out. Ephemeral panes are skipped, so a restart reopens no page. */
export function encodePaneLayoutSnapshot(state: PaneLayoutState): PaneLayoutSnapshotRecord {
  const header: Record<string, number | boolean | string> = {
    version: PANE_LAYOUT_SNAPSHOT_VERSION,
    density: state.density,
  };
  if (state.focusedPaneId !== undefined) {
    header["focusedPaneId"] = state.focusedPaneId;
  }

  const snapshot: PaneLayoutSnapshotRecord = { [PANE_LAYOUT_SNAPSHOT_HEADER_KEY]: header };
  let position = 0;
  for (const pane of state.panes) {
    if (pane.isEphemeral) {
      continue;
    }
    const entry: Record<string, number | boolean | string> = {
      position,
      kind: pane.kind,
      sizePermille: pane.sizePermille,
    };
    if (pane.entity !== undefined) {
      entry["entityKind"] = pane.entity.kind;
      entry["entityId"] = pane.entity.id;
    }
    snapshot[pane.paneId] = entry;
    position += 1;
  }
  return snapshot;
}

/**
 * Reads a snapshot back, dropping what this build cannot interpret. `restoredPaneCap` is a
 * parameter so a test can drive the boundary with two panes instead of thirteen.
 */
export function decodePaneLayoutSnapshot(
  snapshot: unknown,
  restoredPaneCap: number,
): DecodedPaneLayoutSnapshot {
  if (!isWireRecord(snapshot)) {
    return emptyDecode(
      refusePaneLayoutRestore(
        "snapshot-shape-invalid",
        "The saved layout is not a layout record, so none of it was restored. The session opens with no panes.",
      ),
    );
  }

  const header = snapshot[PANE_LAYOUT_SNAPSHOT_HEADER_KEY];
  if (!isWireRecord(header) || header["version"] !== PANE_LAYOUT_SNAPSHOT_VERSION) {
    // Discarded whole: a partly adopted layout hides which part went missing.
    return emptyDecode(
      refusePaneLayoutRestore(
        "snapshot-version-unknown",
        "The saved layout was written by a different version of the app, so none of it was restored. The session opens with no panes and saves again as you arrange them.",
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
  // Keyed off the decoded pane, so malformed entity members still refuse as
  // `pane-entity-invalid`; a duplicate is a coherent pane at a taken address.
  const adoptedAddressKeys = new Set<string>();
  for (const candidate of candidates) {
    if (panes.length >= restoredPaneCap) {
      refusals.push(
        refusePaneLayoutRestore(
          "restore-cap-exceeded",
          `The saved layout held more than ${String(restoredPaneCap)} panes. The first ${String(restoredPaneCap)} were restored and the rest were left closed.`,
        ),
      );
      break;
    }
    const pane = decodePane(candidate.paneId, candidate.entry, refusals);
    if (pane === undefined) {
      continue;
    }
    const addressKey = paneAddressKey(pane);
    if (adoptedAddressKeys.has(addressKey)) {
      // Dropped before the push, so repeats of one address cannot push real panes past the cap.
      refusals.push(
        refusePaneLayoutRestore(
          "pane-address-duplicate",
          "Two saved panes showed the same thing, so the second was left closed.",
        ),
      );
      continue;
    }
    adoptedAddressKeys.add(addressKey);
    panes.push(pane);
  }

  const focusedCandidate = header["focusedPaneId"];
  return {
    panes: normalize(panes),
    focusedPaneId:
      typeof focusedCandidate === "string" && panes.some((pane) => pane.paneId === focusedCandidate)
        ? focusedCandidate
        : panes[0]?.paneId,
    // An unknown preset takes the default; a missing floor would squeeze panes to nothing.
    density: isPaneLayoutDensity(header["density"])
      ? header["density"]
      : DEFAULT_PANE_LAYOUT_DENSITY,
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
    density: DEFAULT_PANE_LAYOUT_DENSITY,
    refusals: [refusal],
  };
}

function decodePane(
  paneId: string,
  entry: UnknownRecord,
  refusals: PaneLayoutRestoreRefusal[],
): SessionPane | undefined {
  const kind = entry["kind"];
  if (isPaneKind(kind) && isEphemeralPaneKind(kind)) {
    // This build never writes one, so the record came from elsewhere. Checked ahead of the
    // address grammar, which would admit it: an ephemeral pane's address is valid, but saving it
    // would reopen a page nobody asked for.
    refusals.push(
      refusePaneLayoutRestore(
        "pane-kind-unknown",
        "One saved pane is a kind the app never saves, so it was left closed.",
      ),
    );
    return undefined;
  }

  // Admission uses the one pane-address grammar. A weaker check would admit a `transcript` over
  // an artifact or an id like `bad/id`, which the pane body then refuses: an unusable pane
  // that counts against the cap and is written back on every save.
  const address = parsePaneAddress(kind, readEntityCandidate(entry));
  if (isRefusal(address)) {
    // Two messages cover every parse code; what a person can do about a dropped pane is the
    // same either way.
    refusals.push(
      address.code === "pane-kind-unknown"
        ? refusePaneLayoutRestore(
            "pane-kind-unknown",
            "One saved pane is a kind this version of the app does not have, so it was left closed.",
          )
        : refusePaneLayoutRestore(
            "pane-entity-invalid",
            "One saved pane named something the app could not resolve, so it was left closed.",
          ),
    );
    return undefined;
  }

  const sizePermille = entry["sizePermille"];
  return {
    paneId,
    kind: address.kind,
    entity: "entity" in address ? address.entity : undefined,
    sizePermille:
      typeof sizePermille === "number" && Number.isFinite(sizePermille) && sizePermille > 0
        ? sizePermille
        : PANE_LAYOUT_TOTAL_PERMILLE,
    isEphemeral: false,
    sourcePaneId: undefined,
  };
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function readPosition(entry: UnknownRecord): number {
  const position = entry["position"];
  return typeof position === "number" && Number.isFinite(position)
    ? position
    : Number.MAX_SAFE_INTEGER;
}

/**
 * Gathers the record's flat `entityKind` and `entityId` into the candidate the address grammar
 * reads. Absent both is a session-scoped pane; either alone is left for the grammar to refuse.
 */
function readEntityCandidate(entry: UnknownRecord): unknown {
  const kind = entry["entityKind"];
  const id = entry["entityId"];
  return kind === undefined && id === undefined ? undefined : { kind, id };
}
