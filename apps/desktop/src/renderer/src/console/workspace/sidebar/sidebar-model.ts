// The session sidebar's rules, with nothing rendered and nothing stored.
//
// `Spec-023 §Console Design (Meridian)` §The surface set: "The session sidebar shows
// the session's other work as independently loaded sections — goal, channels, runs,
// agents, repos and worktrees, approvals, artifacts, members — each a composition of
// its own read, opening panes; a section carrying an amber or red item is open and
// every other section is collapsed." Density rule 7 states the same property from the
// other end: "sidebar sections stay collapsed unless they carry an amber or red item".
//
// THREE RULES LIVE HERE, AND ONE OF THEM IS THE WHOLE DESIGN:
//
//   • **Exactly one section is open.** Not a set, not a per-section flag. The sentence
//     above is stated over the WHOLE sidebar, which is why the section contract makes
//     `isOpen` something a section is told rather than something it decides.
//   • **Attention decides who that is.** A section reporting amber or red is the open
//     one, and where two report, the FIRST in declared order wins — declared order,
//     because it is the order a person reads down the column, and because "the most
//     urgent" would need a severity comparison across families that no document
//     states. A person's own choice is what decides when nothing is calling.
//   • **A collapsed section is not rendered at all.** That is what makes "independently
//     loaded" affordable: a section body is what starts a section's read, so a sidebar
//     that mounted eight bodies to keep seven of them hidden would run eight reads to
//     show one. The budget rule and the design rule are the same rule here.
//
// AND THE GRAMMAR OF WHAT IS KEPT. The width, the collapse, and the open section are
// the `layout` value class — a record of records of numbers, booleans, and
// identifier-shaped strings — under the sidebar's own record key beside the deck's, in
// the same per-session partition. Nothing is added to `PERSISTED_VALUE_CLASSES`: that
// enumeration is closed and its validator table is keyed by it, so a sidebar that
// needed a new class would be a sidebar keeping something that is not layout.
//
// Decoding is `deck/deck-snapshot.ts`' treatment applied to a much smaller record and
// for its reasons: an unknown version is discarded WHOLE rather than half-adopted, and
// every drop is a typed refusal the sidebar renders rather than a tripwire that throws
// over a record last week's build wrote.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionDescriptor,
  type SidebarSectionId,
} from "../../seats/index.js";
import { type PersistedLayoutRecord } from "../layout-persistence.js";

/**
 * What a section reports when it is calling for somebody.
 *
 * Derived from the seat's own optional reader rather than restated: the closed set is
 * declared once, on the contract the families write against, and this alias is how the
 * sidebar names it without a second union that could drift from it.
 */
export type SidebarSectionAttention = NonNullable<
  ReturnType<NonNullable<SidebarSectionDescriptor["attention"]>>
>;

/** What each section reports right now. Absent means "not calling", never "unknown". */
export type SidebarAttentionBySectionId = Readonly<
  Partial<Record<SidebarSectionId, SidebarSectionAttention>>
>;

/**
 * The DOM attribute a section header carries, so the focus act needs no class name.
 *
 * Here rather than in either component: the header writes it and the sidebar's focus
 * act queries for it, and a second spelling is a focus act that finds nothing.
 */
export const SECTION_HEADER_ATTRIBUTE = "data-sidebar-section";

/**
 * The sidebar's own record key, beside the deck's in the same partition.
 *
 * Two records rather than one for the reason two surfaces have two lifetimes: a
 * sidebar change must not rewrite the deck's arrangement, and a deck drag must not
 * rewrite the sidebar's width.
 */
export const SIDEBAR_LAYOUT_RECORD_KEY = "sidebar-layout";

/**
 * The reserved key carrying the record's own header, on `$deck`'s pattern.
 *
 * Prefixed with `$`, which the persistence identifier charset admits and no section id
 * starts with, so the header can never collide with a section's own entry if one is
 * ever kept beside it.
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

/**
 * How wide the sidebar opens the first time, as a share of the workspace.
 *
 * A layout default rather than a cap, so it sits with the grammar that carries it
 * rather than in `core/constants.ts`. Twenty-two percent is a column wide enough for a
 * section's own rows at the type scale and narrow enough that a two-pane deck still
 * clears the deck's own density floor on a 1280 px window.
 */
export const SIDEBAR_DEFAULT_WIDTH_PERCENT = 22;

/** The narrowest and widest the sidebar may be kept at, in percent. */
export const SIDEBAR_MINIMUM_WIDTH_PERCENT = 12;
export const SIDEBAR_MAXIMUM_WIDTH_PERCENT = 40;

/**
 * The width a collapsed sidebar occupies, in pixels.
 *
 * Not zero: the collapsed rail carries the control that expands it again, and a
 * sidebar collapsed to nothing is a sidebar a pointer cannot get back.
 */
export const SIDEBAR_COLLAPSED_WIDTH_PX = 40;

/** What the sidebar keeps between visits. */
export interface SidebarLayoutState {
  readonly widthPercent: number;
  readonly isCollapsed: boolean;
  /** The section the person last opened, which decides when nothing is calling. */
  readonly chosenSectionId: SidebarSectionId | undefined;
}

/** The sidebar as it opens before anything has been restored. */
export const INITIAL_SIDEBAR_LAYOUT_STATE: SidebarLayoutState = {
  widthPercent: SIDEBAR_DEFAULT_WIDTH_PERCENT,
  isCollapsed: false,
  // Collapsed by default is rule 7 read literally: nothing is open until something
  // calls for a person or a person opens it.
  chosenSectionId: undefined,
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

/** A decoded record: the state to adopt, and everything the decode dropped. */
export interface DecodedSidebarLayout {
  readonly state: SidebarLayoutState;
  readonly refusals: readonly ConsoleRefusal[];
}

function refuseRestore(code: SidebarRestoreRefusalCode, detail: string): ConsoleRefusal {
  return refuse(SIDEBAR_LAYOUT_REFUSAL_ORIGIN, code, detail);
}

/** Write the sidebar's state out, under the one class the chokepoint admits. */
export function encodeSidebarLayout(state: SidebarLayoutState): PersistedLayoutRecord {
  const header: Record<string, number | boolean | string> = {
    version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
    widthPercent: state.widthPercent,
    isCollapsed: state.isCollapsed,
  };
  if (state.chosenSectionId !== undefined) {
    header["openSectionId"] = state.chosenSectionId;
  }
  return { [SIDEBAR_SNAPSHOT_HEADER_KEY]: header };
}

/**
 * Read one back, dropping what this build cannot interpret.
 *
 * Every arm answers with a complete state, so a caller never has to decide what a
 * half-decoded sidebar looks like: what could not be read takes the value the sidebar
 * opens with, and the drop is reported rather than silently applied.
 */
export function decodeSidebarLayout(record: unknown): DecodedSidebarLayout {
  if (!isPlainRecord(record)) {
    return {
      state: INITIAL_SIDEBAR_LAYOUT_STATE,
      refusals: [
        refuseRestore(
          "snapshot-shape-invalid",
          "The saved sidebar is not a sidebar record, so none of it was restored. The sidebar opens at its usual width.",
        ),
      ],
    };
  }

  const header = record[SIDEBAR_SNAPSHOT_HEADER_KEY];
  if (!isPlainRecord(header) || header["version"] !== SIDEBAR_LAYOUT_SNAPSHOT_VERSION) {
    // Discarded WHOLE, on the deck's reasoning: a grammar this build does not know is
    // a grammar whose members it cannot interpret.
    return {
      state: INITIAL_SIDEBAR_LAYOUT_STATE,
      refusals: [
        refuseRestore(
          "snapshot-version-unknown",
          "The saved sidebar was written by a different version of the console, so none of it was restored. It opens at its usual width and saves again as you use it.",
        ),
      ],
    };
  }

  const refusals: ConsoleRefusal[] = [];
  const chosenCandidate = header["openSectionId"];
  let chosenSectionId: SidebarSectionId | undefined;
  if (chosenCandidate !== undefined) {
    if (isSidebarSectionId(chosenCandidate)) {
      chosenSectionId = chosenCandidate;
    } else {
      refusals.push(
        refuseRestore(
          "section-unknown",
          "The section the sidebar had open is not one this version of the console has, so the sidebar opens with every section collapsed.",
        ),
      );
    }
  }

  const widthCandidate = header["widthPercent"];
  return {
    state: {
      widthPercent:
        typeof widthCandidate === "number"
          ? clampSidebarWidthPercent(widthCandidate)
          : SIDEBAR_DEFAULT_WIDTH_PERCENT,
      isCollapsed: header["isCollapsed"] === true,
      chosenSectionId,
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

/**
 * Which single section is open: the first one calling, else the person's choice.
 *
 * Total over the declared tuple rather than over the registered subset, so a section
 * nobody has filled still takes its turn — the sidebar renders every declared section
 * and an unfilled one renders its absence, which is a different fact from a section
 * that is not there.
 */
export function resolveOpenSectionId(
  attentionBySectionId: SidebarAttentionBySectionId,
  chosenSectionId: SidebarSectionId | undefined,
): SidebarSectionId | undefined {
  const calling = SIDEBAR_SECTION_IDS.find(
    (sectionId) => attentionBySectionId[sectionId] !== undefined,
  );
  return calling ?? chosenSectionId;
}

/**
 * What pressing a section header settles on.
 *
 * Pressing the open one closes it, which is what makes "collapsed" reachable without a
 * second control — and pressing another opens that one, which collapses the first by
 * construction rather than by a second act that could be forgotten.
 */
export function chooseSectionOnPress(
  pressed: SidebarSectionId,
  chosenSectionId: SidebarSectionId | undefined,
): SidebarSectionId | undefined {
  return pressed === chosenSectionId ? undefined : pressed;
}

/**
 * The label a person reads on each section header.
 *
 * Total over the union by construction, so a section added to the tuple fails to
 * compile here rather than rendering as its own identifier.
 */
export const SIDEBAR_SECTION_LABELS: Readonly<Record<SidebarSectionId, string>> = {
  goal: "Goal",
  channels: "Channels",
  runs: "Runs",
  agents: "Agents",
  repos: "Repos and worktrees",
  approvals: "Approvals",
  artifacts: "Artifacts",
  members: "Members",
};

/** Whether a decoded string names one of the declared sections. */
function isSidebarSectionId(candidate: unknown): candidate is SidebarSectionId {
  return (
    typeof candidate === "string" && (SIDEBAR_SECTION_IDS as readonly string[]).includes(candidate)
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
