// The deck's persisted grammar: what a saved layout looks like, and what a restore
// refuses to believe.
//
// This module holds three of the deck's five rules, and each one is a decision rather
// than a mechanism. `Spec-023 §The surface set` states the first two in one sentence —
// "A layout snapshot of an unknown version is discarded whole, an unknown pane kind is
// dropped and reported, and an entity id that fails validation is rejected" — and the
// third is this module's own, because no committed document states it:
//
//   • **A snapshot of an unknown version is discarded WHOLE.** Not repaired, not
//     partially adopted: a grammar this build does not know is a grammar whose
//     members it cannot interpret, and a half-restored deck is worse than an empty
//     one because the person cannot tell which half is missing.
//   • **An unknown pane kind is dropped and REPORTED.** Version skew is ordinary —
//     a snapshot written by a newer build names kinds this one has not got — so the
//     drop is a typed refusal the deck renders, never a thrown tripwire.
//   • **The restore count is capped.** A snapshot is untrusted input the moment it
//     is on disk; without a cap a corrupted or hand-edited record mounts an
//     unbounded number of panes before anything can say no.
//
// AND ONE THE DECK'S OWN STORE STATES AND THIS FILE HAS TO HONOUR: **one entity,
// one pane**. `open()` enforces it by focusing the pane that already shows an
// address, which repairs nothing it did not create — a record holding two pane ids
// at one address would mount both bodies, consume two cap slots, and be written
// back on the next save, surviving every restart. So a duplicate address is
// coalesced HERE, during decoding, first in position order winning, and the drop is
// reported like every other one. Coalesced rather than refused whole: the record is
// otherwise readable, and discarding a person's arrangement over one repeated
// address would be the version-skew treatment applied to something that is not
// version skew.
//
// REPORTING, AND WHY IT IS NOT A TRIPWIRE. `core/tripwires.ts` owns five kinds and
// each one names a DEFECT; a tripwire throws in a development build, which is
// exactly right for a store mutated outside its chokepoint and exactly wrong for a
// snapshot written by last week's build. So decoding answers with typed
// `ConsoleRefusal`s — the console's one refusal shape — which the deck renders
// through `primitives/Refusal`. The drop is loud, counted, and on screen; it is not
// a crash.
//
// PURE, AND DELIBERATELY SO. Encoding takes a state and returns a record; decoding
// takes an unknown and returns panes plus refusals. Neither touches a layout, which
// is what lets the grammar be tested against hand-written records — including ones
// no version of this console would ever write.

import { isConsoleRefusal, isWireRecord, refuse, type NarrowedRefusal } from "../../core/index.js";
import { isPaneKind, parseConsolePaneAddress } from "../../seats/index.js";
import { DEFAULT_DECK_DENSITY, type DeckDensity } from "../workspace-bounds.js";
import { isDeckDensity } from "./density.js";
import {
  DECK_TOTAL_PERMILLE,
  EPHEMERAL_PANE_KINDS,
  normalise,
  paneAddressKey,
  type DeckLayoutState,
  type DeckPane,
} from "./deck-model.js";

/**
 * The snapshot grammar's version.
 *
 * A schema version rather than a cap, so it lives with the code that writes and
 * reads the grammar rather than in `core/constants.ts`: the two halves of one
 * grammar in two files is exactly the drift `src/shared/auxiliary-routes.ts` names.
 * Bump it whenever a member's MEANING changes; a restore of any other value
 * discards the whole record.
 */
export const DECK_LAYOUT_SNAPSHOT_VERSION = 1;

/**
 * The reserved snapshot key carrying the record's own header.
 *
 * Prefixed with `$`, which the persistence identifier charset admits and no minted
 * pane id starts with, so a pane can never collide with the header. Reading it is
 * how a restore learns the version before it interprets anything else.
 */
export const DECK_SNAPSHOT_HEADER_KEY = "$deck";

/**
 * The record shape the persistence chokepoint stores under the `layout` value class.
 *
 * An object of objects whose members are numbers, booleans, and identifier-shaped
 * strings — the chokepoint's constraint, not this module's preference. A nested
 * array of pane objects would be refused at the write, and the refusal would arrive
 * a release after the code that caused it.
 */
export type DeckSnapshotRecord = Record<string, Record<string, number | boolean | string>>;

/** Why a restore dropped something. Closed, so an eighth cause is a decision. */
export const DECK_RESTORE_REFUSAL_CODES = [
  "snapshot-shape-invalid",
  "snapshot-version-unknown",
  "pane-shape-invalid",
  "pane-kind-unknown",
  "pane-entity-invalid",
  "pane-address-duplicate",
  "restore-cap-exceeded",
] as const;

/** One restore refusal code. Derived, so the vocabulary is declared once. */
export type DeckRestoreRefusalCode = (typeof DECK_RESTORE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const DECK_LAYOUT_REFUSAL_ORIGIN = "deck-layout";

/** A typed restore refusal — `core`'s one refusal shape, narrowed on `code`. */
export type DeckRestoreRefusal = NarrowedRefusal<DeckRestoreRefusalCode>;

/** What one restore did, and everything it refused. Rendered, never swallowed. */
export interface DeckRestoreReport {
  readonly restoredPaneCount: number;
  readonly refusals: readonly DeckRestoreRefusal[];
}

/** A decoded snapshot: the panes to adopt, the header's choices, and the drops. */
export interface DecodedDeckSnapshot {
  readonly panes: readonly DeckPane[];
  readonly focusedPaneId: string | undefined;
  readonly density: DeckDensity;
  readonly refusals: readonly DeckRestoreRefusal[];
}

/**
 * This module's refusals, named for the restore they are about.
 *
 * NAMED `Deck` for the reason `sidebar/sidebar-model.ts`'s twin is named `Sidebar`:
 * the two are sibling restore paths in one family and a shared bare name made them
 * look interchangeable when their refusal types are not.
 */
function refuseDeckRestore(code: DeckRestoreRefusalCode, detail: string): DeckRestoreRefusal {
  return refuse(DECK_LAYOUT_REFUSAL_ORIGIN, code, detail);
}

/** Write a state out. Ephemeral panes are skipped, so a restart reopens no page. */
export function encodeDeckSnapshot(state: DeckLayoutState): DeckSnapshotRecord {
  const header: Record<string, number | boolean | string> = {
    version: DECK_LAYOUT_SNAPSHOT_VERSION,
    density: state.density,
  };
  if (state.focusedPaneId !== undefined) {
    header["focusedPaneId"] = state.focusedPaneId;
  }

  const snapshot: DeckSnapshotRecord = { [DECK_SNAPSHOT_HEADER_KEY]: header };
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
 * Read a snapshot back, dropping what this build cannot interpret.
 *
 * `restoredPaneCap` is passed rather than read from a constant so the cap is the
 * caller's decision and a test can drive the boundary with two panes instead of
 * thirteen.
 */
export function decodeDeckSnapshot(
  snapshot: unknown,
  restoredPaneCap: number,
): DecodedDeckSnapshot {
  if (!isWireRecord(snapshot)) {
    return emptyDecode(
      refuseDeckRestore(
        "snapshot-shape-invalid",
        "The saved layout is not a layout record, so none of it was restored. The deck opens empty.",
      ),
    );
  }

  const header = snapshot[DECK_SNAPSHOT_HEADER_KEY];
  if (!isWireRecord(header) || header["version"] !== DECK_LAYOUT_SNAPSHOT_VERSION) {
    // Discarded WHOLE. A grammar this build does not know is a grammar whose
    // members it cannot interpret, and a partly-adopted deck hides which part
    // went missing.
    return emptyDecode(
      refuseDeckRestore(
        "snapshot-version-unknown",
        "The saved layout was written by a different version of the console, so none of it was restored. The deck opens empty and saves again as you arrange it.",
      ),
    );
  }

  const refusals: DeckRestoreRefusal[] = [];
  const candidates: { readonly paneId: string; readonly entry: UnknownRecord }[] = [];
  for (const [paneId, entry] of Object.entries(snapshot)) {
    if (paneId === DECK_SNAPSHOT_HEADER_KEY) {
      continue;
    }
    if (!isWireRecord(entry)) {
      refusals.push(
        refuseDeckRestore(
          "pane-shape-invalid",
          "One saved pane was not a pane record and was ignored.",
        ),
      );
      continue;
    }
    candidates.push({ paneId, entry });
  }
  candidates.sort((left, right) => readPosition(left.entry) - readPosition(right.entry));

  const panes: DeckPane[] = [];
  // Keyed off the DECODED pane rather than off the raw entry, so a record whose
  // entity members are malformed still refuses as `pane-entity-invalid` — a
  // duplicate is a coherent pane at an address already taken, not a broken one.
  const adoptedAddressKeys = new Set<string>();
  for (const candidate of candidates) {
    if (panes.length >= restoredPaneCap) {
      refusals.push(
        refuseDeckRestore(
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
      // Dropped BEFORE the push, so it consumes no cap slot: a record padded with
      // repeats of one address must not push real panes out of the restore.
      refusals.push(
        refuseDeckRestore(
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
    panes: normalise(panes),
    focusedPaneId:
      typeof focusedCandidate === "string" && panes.some((pane) => pane.paneId === focusedCandidate)
        ? focusedCandidate
        : panes[0]?.paneId,
    // An unrecognised preset takes the default rather than a hole: the preset
    // decides a floor, and a floor of `undefined` squeezes panes to nothing.
    density: isDeckDensity(header["density"]) ? header["density"] : DEFAULT_DECK_DENSITY,
    refusals,
  };
}

function emptyDecode(refusal: DeckRestoreRefusal): DecodedDeckSnapshot {
  return {
    panes: [],
    focusedPaneId: undefined,
    density: DEFAULT_DECK_DENSITY,
    refusals: [refusal],
  };
}

function decodePane(
  paneId: string,
  entry: UnknownRecord,
  refusals: DeckRestoreRefusal[],
): DeckPane | undefined {
  const kind = entry["kind"];
  if (isPaneKind(kind) && EPHEMERAL_PANE_KINDS.includes(kind)) {
    // Nothing this build writes can produce one, so its presence means the record
    // was written by something else. Refused for the same reason it is never
    // written: a restart must not reopen a page nobody asked for. Ahead of the
    // grammar below, which would admit it — an ephemeral pane's address is a valid
    // address, and what is wrong with it is that it was SAVED.
    refusals.push(
      refuseDeckRestore(
        "pane-kind-unknown",
        "One saved pane is a kind the console never saves, so it was left closed.",
      ),
    );
    return undefined;
  }

  // THE ADMISSION IS THE CONSOLE'S ONE PANE-ADDRESS GRAMMAR, and not a reading of
  // its own. A weaker one here — any known entity kind, any non-empty id — admits a
  // `timeline` opened over an artifact and an id like `bad/id`, and the body that
  // mounts the row then refuses it: an unusable pane holding one of the cap's slots,
  // written straight back out on the next save and surviving every restart. The
  // grammar knows both things this one cannot: WHICH entity kinds each pane kind is
  // a view of, and what an identifier is allowed to look like.
  const address = parseConsolePaneAddress(kind, readEntityCandidate(entry));
  if (isConsoleRefusal(address)) {
    // Two sentences for five parse codes, because what a person can do about a
    // dropped pane is the same either way, and this module's own vocabulary is
    // closed. The parse's code is the precise one and stays where it was raised.
    refusals.push(
      address.code === "pane-kind-unknown"
        ? refuseDeckRestore(
            "pane-kind-unknown",
            "One saved pane is a kind this version of the console does not have, so it was left closed.",
          )
        : refuseDeckRestore(
            "pane-entity-invalid",
            "One saved pane named something the console could not resolve, so it was left closed.",
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
        : DECK_TOTAL_PERMILLE,
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
 * The record's two flat entity members, gathered into the shape the grammar reads.
 *
 * The snapshot stores `entityKind` and `entityId` side by side at the top of a pane
 * entry, because a record is flat; the pane-address grammar takes one candidate
 * object. This is that translation and nothing else — it decides nothing about
 * whether either value is any good, which is the whole point of handing them on.
 *
 * All-or-nothing, on `src/shared/auxiliary-routes.ts`' reasoning about its own
 * context grammar: absent BOTH members is a session-scoped pane, and either member
 * alone is a candidate the grammar refuses rather than a pane the reader guesses the
 * rest of.
 */
function readEntityCandidate(entry: UnknownRecord): unknown {
  const kind = entry["entityKind"];
  const id = entry["entityId"];
  return kind === undefined && id === undefined ? undefined : { kind, id };
}
