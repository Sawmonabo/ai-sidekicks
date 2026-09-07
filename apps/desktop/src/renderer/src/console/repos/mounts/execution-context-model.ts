// The three roots one workspace runs against, and whether the mode it runs in is the
// mode it asked for.
//
// WHY THREE PATHS AND NOT ONE. A workspace card today renders `fsRoot`, and `fsRoot`
// alone is ambiguous in exactly the case that matters. `Spec-009 §Repo Identity And
// Common-Directory Keying (V1 Definition)` makes the mount's `canonicalRoot` the
// resolver's output and the key the trust envelope is built on; the workspace's BOUND
// root is where this binding executes, which under `branch` mode is that same checkout
// and under `worktree` mode is somewhere else entirely; and the NORMALIZED CHECKOUT
// ROOT is a third value the turn-snapshot service operates on, captured per run and
// carried on the run's own execution context. None of the three is derived from
// another, and a surface showing one of them lets a person read a snapshot taken
// somewhere else as a snapshot taken here.
//
// THE RENDERER COMPARES THEM AND RESOLVES NOTHING. `MountCard.tsx` states the rule
// this module obeys: containment, symlink resolution, case folding, and
// working-tree-boundary awareness are daemon rules, so nothing here canonicalises a
// path or decides whether two spellings are the same place. What it does is report
// BYTE equality between two strings the daemon sent — which is a fact about the reply
// rather than a fact about the filesystem, and is labelled as one.
//
// AND THE FALLBACK MARKER IS NOT A DERIVATION EITHER. `Spec-010 §Fallback Behavior`
// requires an execution mode the daemon SUBSTITUTED to be marked distinctly from one
// the participant chose, and the workspace list carries no member that says so — its
// `executionMode` is the mode in force and reads identically either way. So the marker
// travels on the execution-context read, and a reading that carries none means the
// binding is running the mode it was asked for.

import type { ConsoleRefusal } from "../../core/index.js";

/**
 * One workspace's execution context, as the console reads it.
 *
 * MIRRORS THE GROWTH SIGNATURE AND DOES NOT WIDEN IT. The two optional members are
 * optional on the wire for different reasons and the surface renders each absence
 * differently: a binding whose run has not captured a checkout root yet has none to
 * report, and a binding running its requested mode has no substitution to name.
 * Collapsing either into a default would report a fact nobody sent.
 */
export interface WorkspaceExecutionContext {
  readonly workspaceId: string;
  readonly boundRoot: string;
  readonly checkoutRoot?: string;
  readonly fallbackFromMode?: string;
}

/**
 * Where one workspace's execution-context read stands.
 *
 * FOUR ARMS, WHICH IS RULE 8'S SEPARATION AND NOT A CONVENIENCE. `not-read` is a
 * question nobody has put yet, `reading` is one in flight, `read` is an answer, and
 * `refused` is a wire that said no. A surface collapsing the first and the last would
 * report a refused read as a read never made, which invites a wait for an answer that
 * has already come back.
 */
export type ExecutionContextReading =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly context: WorkspaceExecutionContext }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** Nothing has been asked yet. The reading every reader opens on. */
export const EXECUTION_CONTEXT_NOT_READ: ExecutionContextReading = { status: "not-read" };

/** One labelled path, and what the surface may honestly say about it. */
export interface ExecutionPathRow {
  /** Which of the three roots this is. A label, not a sentence. */
  readonly label: string;
  /** Why this root exists, in one line, so the three are distinguishable. */
  readonly meaning: string;
  /** The path the daemon sent, verbatim. Absent where the reply carried none. */
  readonly value: string | undefined;
  /**
   * Why this row has no path, where it has none.
   *
   * Its own member rather than a sentinel in `value`, because a path and a reason a
   * path is missing are two different kinds of string and a surface that rendered
   * them in one slot would put prose where it middle-truncates a root.
   */
  readonly absence: string | undefined;
  /**
   * Whether this row's path is byte-identical to the row above it.
   *
   * A READING OF TWO REPLIES, NEVER A CLAIM ABOUT THE FILESYSTEM. Two spellings of one
   * directory are not equal here and this member does not say they are — it says the
   * daemon sent the same bytes twice, which is what makes a three-row disclosure
   * legible when a `branch`-mode binding really does execute in the mount's own
   * checkout.
   */
  readonly matchesPrevious: boolean;
}

/** The label the three rows carry, declared once so the disclosure and its tests agree. */
export const MOUNT_ROOT_LABEL = "Mount root";
/** The second row's label. */
export const BOUND_ROOT_LABEL = "Bound root";
/** The third row's label. */
export const CHECKOUT_ROOT_LABEL = "Normalized checkout root";

/**
 * The three paths, in the order a person reads them: outermost fact first.
 *
 * MOUNT ROOT FIRST BECAUSE IT IS THE ONE THAT NEVER MOVES. It is what the mount was
 * attached as and what every other root is understood against, so a disclosure that
 * opened on the bound root would present the variable before the constant. The
 * checkout root is last because it is the most derived of the three — a normalization
 * of the bound root captured at a run boundary — and because it is the one most often
 * absent.
 *
 * TOTAL OVER THE READING'S SERVED ARM AND NOTHING ELSE. A refused or unmade read has
 * no bound root to place beside the mount's, so the surface renders that reading's own
 * absence rather than a table with two empty rows — which is why this takes a context
 * and not a reading.
 */
export function executionPathRows(
  mountCanonicalRoot: string,
  context: WorkspaceExecutionContext,
): readonly ExecutionPathRow[] {
  return [
    {
      label: MOUNT_ROOT_LABEL,
      meaning: "What the mount resolved to when it was attached.",
      value: mountCanonicalRoot,
      absence: undefined,
      matchesPrevious: false,
    },
    {
      label: BOUND_ROOT_LABEL,
      meaning: "Where this workspace's runs execute.",
      value: context.boundRoot,
      absence: undefined,
      matchesPrevious: context.boundRoot === mountCanonicalRoot,
    },
    {
      label: CHECKOUT_ROOT_LABEL,
      meaning: "What the turn-snapshot service captures and restores against.",
      value: context.checkoutRoot,
      absence:
        context.checkoutRoot === undefined
          ? "No run has captured an execution context for this workspace yet."
          : undefined,
      matchesPrevious: context.checkoutRoot === context.boundRoot,
    },
  ];
}

/**
 * One honest line per reading, for a summary that has room for exactly one.
 *
 * TOTAL OVER THE FOUR ARMS, so a fifth would fail to compile here rather than falling
 * through to a line about some other state. The served arm's line reports what the
 * disclosure would show — whether the three roots agree — because that is the one
 * question a person opens it to answer, and a summary that answered it saves the open.
 *
 * IT COMPARES ALL THREE AND NOT TWO OF THEM. The agreement claim is about the rows
 * `executionPathRows` builds, and there are three of those: a summary that read the
 * bound root against the checkout root alone would report agreement for every
 * `worktree`-mode binding, whose execution root sits outside the mount it was attached
 * as — which is the exact case this disclosure exists for. So the mount root is a
 * parameter rather than a value this module could reach: it is the caller's, and a
 * summary that had to guess at it would be guessing at the row that never moves.
 */
export function executionRootsSummaryLine(
  reading: ExecutionContextReading,
  mountCanonicalRoot: string,
): string {
  switch (reading.status) {
    case "not-read":
      return "not read";
    case "reading":
      return "reading";
    case "refused":
      return `not available — ${reading.refusal.code}`;
    case "read":
      return summaryLineForContext(reading.context, mountCanonicalRoot);
  }
}

/**
 * The served arm's line, which is a reading of the three rows rather than of two paths.
 *
 * Reads `executionPathRows`' own verdicts rather than re-comparing the strings here,
 * so the summary and the table it summarises cannot disagree: a row that says it
 * matches the one above it is the only evidence this line has, and there is one place
 * that decides it.
 */
function summaryLineForContext(
  context: WorkspaceExecutionContext,
  mountCanonicalRoot: string,
): string {
  if (context.checkoutRoot === undefined) {
    return "no captured checkout root";
  }
  const rows = executionPathRows(mountCanonicalRoot, context);
  return rows.every((row, index) => index === 0 || row.matchesPrevious)
    ? "all three roots agree"
    : "the roots differ";
}

/** The badge a substituted execution mode wears, and the sentence beside it. */
export interface FallbackBadge {
  /** What the chip says. Names the mode that was ASKED FOR, which is the surprising half. */
  readonly label: string;
  /** Why the mode in force is not the mode requested, in the console's own words. */
  readonly sentence: string;
}

/**
 * The fallback badge for one execution context, where the daemon substituted a mode.
 *
 * `undefined` IS THE ORDINARY ANSWER and carries no sentence. A binding running the
 * mode it was asked for has nothing to disclose, and a surface that printed "not
 * substituted" on every workspace would spend its most legible line on the case that
 * needs no attention at all.
 *
 * THE LABEL NAMES THE REQUESTED MODE RATHER THAN THE MODE IN FORCE, because the mode
 * in force is already on the row — the workspace card's own `executionMode` chip — and
 * a badge repeating it would say nothing the row does not. What is not on the row
 * anywhere is what the participant asked for, which is the whole of what the marker
 * carries.
 */
export function fallbackBadgeFor(context: WorkspaceExecutionContext): FallbackBadge | undefined {
  if (context.fallbackFromMode === undefined) {
    return undefined;
  }
  return {
    label: `fell back from ${context.fallbackFromMode}`,
    sentence:
      "The daemon could not bind the requested execution mode and substituted the one in force. Runs continue in the substituted mode; nothing about the binding is retried automatically.",
  };
}
