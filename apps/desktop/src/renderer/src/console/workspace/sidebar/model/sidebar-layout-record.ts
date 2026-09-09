// The one durable record the sidebar keeps, encoder and decoder in one module.
//
// `apps/desktop/AGENTS.md`: "Two sides of one seam (producer and consumer, encoder
// and decoder) share a module." These two are exactly that seam — what the model
// writes and what it reads back — and splitting them would be two shapes to keep in
// step, which is how a value class silently starts round-tripping into something
// else.
//
// ONE RECORD, NOT TWO KEYS. The width, the whole-column collapse, and the set of
// sections the person has shut are one arrangement written at one address, under the
// sidebar's own record key beside the deck's in the same per-session partition. Two
// records — one per axis, or one per scope — is two writes that can half-land and two
// restores that can disagree about which of them a person last touched.
//
// AND THE COLLAPSE IS AN INVERTED SET. What is stored is what the person SHUT, so a
// section this build mints after the last save reads as OPEN and the design rule "a
// section carrying an amber or red item is open" still reaches it. The alternative —
// storing what is open — would hold a new section shut against a rule written to open
// it, invisibly, until somebody pressed it.
//
// Decoding is `deck/model/deck-snapshot.ts`' treatment applied to a much smaller record and
// for its reasons: an unknown version is discarded WHOLE rather than half-adopted, and
// every drop is a typed refusal the sidebar renders rather than a tripwire that throws
// over a record last week's build wrote. Nothing here applies a default the model does
// not also apply — the band the width is held in is this module's because the clamp
// runs on the way IN as well as on the way out, and everything else a decoder cannot
// read takes the state the sidebar opens with.

import { SIDEBAR_MAXIMUM_WIDTH_PERCENT, isWireRecord, refuse } from "../../../core/index.js";
import { type NarrowedRefusal } from "../../../core/index.js";
import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../../seats/index.js";
import { type PersistedLayoutRecord } from "../../layout/layout-writer.js";
import {
  SIDEBAR_DEFAULT_WIDTH_PERCENT,
  SIDEBAR_MINIMUM_WIDTH_PERCENT,
} from "../../workspace-bounds.js";

/** The sidebar's own record key, beside the deck's in the same partition. */
export const SIDEBAR_LAYOUT_RECORD_KEY = "sidebar-layout";

/**
 * The reserved key carrying the record's own header, on `$deck`'s pattern.
 *
 * Prefixed with `$`, which the persistence identifier charset admits and no section id
 * starts with, so the header can never collide with the per-section entries kept
 * beside it.
 */
export const SIDEBAR_SNAPSHOT_HEADER_KEY = "$sidebar";

/**
 * The snapshot grammar's version.
 *
 * A schema version rather than a cap, so it lives with the code that writes and reads
 * the grammar — `deck-snapshot.ts` states the same reason for its own. Bump it
 * whenever a member's MEANING changes; a restore of any other value discards the whole
 * record.
 */
export const SIDEBAR_LAYOUT_SNAPSHOT_VERSION = 1;

/** The member a per-section entry carries. One boolean, because the set is inverted. */
const SECTION_COLLAPSED_MEMBER = "collapsed";

/** What the sidebar keeps between visits. */
export interface SidebarLayoutState {
  readonly widthPercent: number;
  /** Whether the whole column is shut down to the rail's width. */
  readonly isCollapsed: boolean;
  /** The ids the person has SHUT. Inverted, so an id this build does not hold reads as open. */
  readonly collapsedSectionIds: ReadonlySet<SidebarSectionId>;
}

/**
 * The sidebar as it opens before anything has been restored.
 *
 * Every section shut, which is the design rule read literally — "sidebar sections stay
 * collapsed unless they carry an amber or red item" — and is also what keeps the first
 * frame cheap: a collapsed section mounts no body, so an unrestored sidebar starts no
 * reads it is about to abandon. The alternative, open until proven collapsed, flashes
 * the whole tree open on every load and then shuts it.
 */
export const INITIAL_SIDEBAR_LAYOUT_STATE: SidebarLayoutState = {
  widthPercent: SIDEBAR_DEFAULT_WIDTH_PERCENT,
  isCollapsed: false,
  collapsedSectionIds: new Set(SIDEBAR_SECTION_IDS),
};

/** Why a restore dropped something. Closed, so a fourth cause is a decision. */
export const SIDEBAR_RESTORE_REFUSAL_CODES = [
  "snapshot-shape-invalid",
  "snapshot-version-unknown",
  "section-unknown",
] as const;

/** One restore refusal code. Derived, so the vocabulary is declared once. */
export type SidebarRestoreRefusalCode = (typeof SIDEBAR_RESTORE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const SIDEBAR_LAYOUT_REFUSAL_ORIGIN = "sidebar-layout";

/**
 * A typed sidebar restore refusal — `core`'s one refusal shape, narrowed on `code`.
 *
 * Narrowed for the reason the deck's own `DeckRestoreRefusal` is: a consumer that
 * switches on `.code` gets the vocabulary checked against the union above rather than
 * against `string`, so a code that is no longer in the set is a compile error and not a
 * branch that stops being taken.
 */
export type SidebarRestoreRefusal = NarrowedRefusal<SidebarRestoreRefusalCode>;

/** A decoded record: the state to adopt, and everything the decode dropped. */
export interface DecodedSidebarLayout {
  readonly state: SidebarLayoutState;
  readonly refusals: readonly SidebarRestoreRefusal[];
}

/**
 * Write the sidebar's state out, under the one class the chokepoint admits.
 *
 * The collapsed ids are walked in the seat's declared order rather than the set's
 * insertion order, so two runs that shut the same sections write the same record and a
 * store comparing bytes records no change nobody made.
 */
export function encodeSidebarLayout(state: SidebarLayoutState): PersistedLayoutRecord {
  const record: Record<string, Record<string, number | boolean | string>> = {
    [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
      version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
      widthPercent: state.widthPercent,
      isCollapsed: state.isCollapsed,
    },
  };
  for (const sectionId of SIDEBAR_SECTION_IDS) {
    if (state.collapsedSectionIds.has(sectionId)) {
      record[sectionId] = { [SECTION_COLLAPSED_MEMBER]: true };
    }
  }
  return record;
}

/**
 * Read one back, dropping what this build cannot interpret.
 *
 * Every arm answers with a complete state, so a caller never has to decide what a
 * half-decoded sidebar looks like: what could not be read takes the value the sidebar
 * opens with, and the drop is reported rather than silently applied.
 */
export function decodeSidebarLayout(record: unknown): DecodedSidebarLayout {
  if (!isWireRecord(record)) {
    return {
      state: INITIAL_SIDEBAR_LAYOUT_STATE,
      refusals: [
        refuseSidebarRestore(
          "snapshot-shape-invalid",
          "The saved sidebar is not a sidebar record, so none of it was restored. The sidebar opens at its usual width.",
        ),
      ],
    };
  }

  const header = record[SIDEBAR_SNAPSHOT_HEADER_KEY];
  if (!isWireRecord(header) || header["version"] !== SIDEBAR_LAYOUT_SNAPSHOT_VERSION) {
    // Discarded WHOLE, on the deck's reasoning: a grammar this build does not know is
    // a grammar whose members it cannot interpret.
    return {
      state: INITIAL_SIDEBAR_LAYOUT_STATE,
      refusals: [
        refuseSidebarRestore(
          "snapshot-version-unknown",
          "The saved sidebar was written by a different version of the console, so none of it was restored. It opens at its usual width and saves again as you use it.",
        ),
      ],
    };
  }

  const refusals: SidebarRestoreRefusal[] = [];
  const collapsedSectionIds = new Set<SidebarSectionId>();
  let hasUnknownSection = false;
  for (const [key, entry] of Object.entries(record)) {
    if (key === SIDEBAR_SNAPSHOT_HEADER_KEY) {
      continue;
    }
    const sectionId = SIDEBAR_SECTION_IDS.find((candidate) => candidate === key);
    if (sectionId === undefined) {
      // DROPPED rather than kept: an id no section has would hold a section shut that
      // nothing on screen can ever re-open. Reported once — a record written by a
      // build with three sections this one lacks is one fact, not three.
      hasUnknownSection = true;
      continue;
    }
    if (isWireRecord(entry) && entry[SECTION_COLLAPSED_MEMBER] === true) {
      collapsedSectionIds.add(sectionId);
    }
  }
  if (hasUnknownSection) {
    refusals.push(
      refuseSidebarRestore(
        "section-unknown",
        "The saved sidebar names a section this version of the console does not have, so that part of it was not restored. Every section this build knows about opened as you left it.",
      ),
    );
  }

  const widthCandidate = header["widthPercent"];
  return {
    state: {
      widthPercent:
        typeof widthCandidate === "number"
          ? clampSidebarWidthPercent(widthCandidate)
          : SIDEBAR_DEFAULT_WIDTH_PERCENT,
      isCollapsed: header["isCollapsed"] === true,
      collapsedSectionIds,
    },
    refusals,
  };
}

/**
 * Hold a width inside the band the sidebar is usable in.
 *
 * Clamped rather than refused, and clamped on the way IN as well as on the way out: a
 * record naming three percent is readable, and a sidebar three percent wide is a
 * sidebar nobody can read. A non-finite number takes the default, because there is no
 * band to clamp it into.
 */
export function clampSidebarWidthPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return SIDEBAR_DEFAULT_WIDTH_PERCENT;
  }
  return Math.min(SIDEBAR_MAXIMUM_WIDTH_PERCENT, Math.max(SIDEBAR_MINIMUM_WIDTH_PERCENT, percent));
}

/** Whether two collapsed sets hold the same sections. */
export function collapsedSectionSetsMatch(
  left: ReadonlySet<SidebarSectionId>,
  right: ReadonlySet<SidebarSectionId>,
): boolean {
  return left.size === right.size && [...left].every((sectionId) => right.has(sectionId));
}

/** This module's refusals, named for the restore they are about. */
function refuseSidebarRestore(
  code: SidebarRestoreRefusalCode,
  detail: string,
): SidebarRestoreRefusal {
  return refuse(SIDEBAR_LAYOUT_REFUSAL_ORIGIN, code, detail);
}
