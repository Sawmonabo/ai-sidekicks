// The console's named bounds.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// This module is that place for the substrate's domains; each view family adds
// its own module beside its subtree rather than widening this one, so a bound
// always sits next to the code that spends it.
//
// A number that appears inline anywhere under `console/` and is not a layout
// literal is a review rejection: the rationale is the point, not the constant.

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";

/**
 * Trailing debounce on the refresh scheduler. Long enough that a burst of
 * events costs one read, short enough that a person does not perceive the lag.
 */
export const REFRESH_DEBOUNCE_MS = 120;

/**
 * Absolute deadline from the FIRST event of a burst. The scheduler fires at
 * `min(lastEvent + REFRESH_DEBOUNCE_MS, firstEvent + REFRESH_MAX_WAIT_MS)`, so a
 * continuous stream cannot starve the trailing debounce forever — the failure
 * mode a bare debounce has and the reason `Spec-023 §Console Design (Meridian)`
 * §The eight rules names an absolute deadline.
 */
export const REFRESH_MAX_WAIT_MS = 1000;

/**
 * Coalescing window for store applies. One animation frame at 60 Hz: events
 * arriving inside it produce one notification, so four streaming lanes cost one
 * render rather than four.
 */
export const APPLY_COALESCE_MS = 16;

/**
 * Wire events one session store holds while it waits for its first read.
 *
 * A store buffers rather than applies until a read response gives it a base
 * state, and that wait is ordinarily the milliseconds between opening a
 * subscription and the read landing — a handful of events. Past this bound the
 * wait is not a race any more, it is a read that is not coming, and the honest
 * response is to stop growing: the oldest is dropped and the loss is recorded
 * (and re-derived exactly, as a sequence gap, the moment a base state does
 * arrive) rather than the buffer holding an entire session's stream forever.
 */
export const PRE_INITIALISATION_BUFFER_CAP = 512;

/**
 * Sequences a session store will carry as a repairable hole before it calls the
 * stream diverged.
 *
 * A hole is recorded as a RANGE rather than one entry per sequence, so a wide one
 * costs exactly what a narrow one does; this bound is about REPAIRABILITY, not
 * about the size of the record. Ordinary loss is small — a delivery dropped on a
 * resumed subscription, or the oldest rows a full `PRE_INITIALISATION_BUFFER_CAP`
 * shed — and a re-pull fills it against the cursor the store already reached,
 * which is why the bound sits above that buffer's whole worth of loss. Past it
 * the arithmetic stops being a hole and starts being a different stream:
 * admitting the event would move the cursor to a position an authoritative read
 * may never answer at, and every later repair would then be refused as a rewind.
 * So past this bound the event is refused, the store says the stream diverged,
 * and a snapshot read — not a fill — is the repair. It bounds the ACCUMULATED
 * loss rather than one jump, which is what keeps the range list bounded too: a
 * range is at least one sequence wide, so there can never be more of them.
 */
export const MAX_REPAIRABLE_SEQUENCE_GAP = 1024;

/**
 * Sessions whose UI state the persistence layer keeps. Past this the least
 * recently touched partition is trimmed, so a long-lived install does not grow
 * an unbounded IndexedDB.
 */
export const PERSISTENCE_SESSION_PARTITION_CAP = 40;

/**
 * Bytes one persisted UI-state RECORD may occupy: its partition, its key, its
 * class, and its serialised value together. A layout snapshot or an expansion set
 * is kilobytes; anything past this is content that does not belong in the store,
 * so the cap is a second line of defence behind the value-class enumeration
 * rather than a performance knob.
 *
 * The address is inside the cap rather than beside it because the address is
 * stored too — a ceiling over the value alone would leave the key unbounded by
 * anything but the identifier grammar, and the key is the part an index holds a
 * second copy of.
 */
export const PERSISTENCE_RECORD_BYTE_CAP: number = 64 * 1024;

/**
 * Fraction of the storage quota at which the gauge reports pressure. Reported,
 * never acted on silently: the console tells the operator rather than dropping
 * their layout behind their back.
 */
export const PERSISTENCE_QUOTA_PRESSURE_RATIO = 0.8;

/** Commands the palette remembers. Enough to cover a working session's rhythm. */
export const PALETTE_RECENTS_CAP = 8;

/**
 * Ranked results the palette renders at once. The list is keyboard-walked, so
 * past this a person is scrolling rather than choosing and should refine instead.
 */
export const PALETTE_RESULT_CAP = 40;

/**
 * Maximum nesting depth of a keybinding when-clause. Bounded so a malformed or
 * hostile expression cannot recurse the parser; past the bound the clause is
 * refused and the binding evaluates false, which is the fail-closed arm.
 */
export const WHEN_CLAUSE_MAX_DEPTH = 8;

/**
 * Participant chips the cast bar shows before folding to "+N" (rule 7).
 *
 * Consumed by T-023p-1C-2, which builds the cast bar; every other bound in this
 * file has a live spender today and this one does not. It is kept rather than
 * deferred to that task because the number is a decision `Spec-023 §Console
 * Design (Meridian)` already fixed, and a bound re-derived at the point of use is
 * a bound that can come back different.
 */
export const CAST_BAR_CHIP_CAP = 8;

/**
 * Tripwire reports retained in memory. A tripwire that keeps firing is one
 * defect, not thousands, so the buffer is small and the counter is what grows.
 */
export const TRIPWIRE_REPORT_CAP = 64;

/**
 * The fixture scenario clock's tick, in milliseconds of scenario time. Every
 * scenario's script is expressed in whole ticks so a frozen tick names one exact
 * frame — which is what makes the screenshot target byte-stable.
 */
export const SCENARIO_TICK_MS = 50;

/**
 * Scripted replies the fixture engine holds waiting for the frozen clock.
 *
 * A held reply is one in-flight request on one surface, so a handful is the
 * whole working set — and the clock only moves when a caller moves it, which
 * means a driver that never advances would otherwise grow this list for the life
 * of the window. Past the cap the fixture refuses the call rather than parking
 * it, because a scenario asking for more concurrent latency than this is being
 * driven by something that will never release any of it.
 */
export const SCENARIO_PENDING_REPLY_CAP = 64;

/**
 * Announcements the live announcer holds in ONE politeness lane while an earlier
 * one is still standing in its region.
 *
 * A screen reader speaks one message at a time, so announcements are serialised
 * rather than overwritten — an overwrite inside the hold window below is a message
 * nobody heard. Past this bound the burst is one condition repeating rather than
 * this many separate things a person needs told, so the OLDEST is dropped: the
 * newest fact is the one still true, and a queue that shed the newest would spend
 * its whole drain reading history. The bound is per lane rather than shared,
 * because the two lanes are two independent speech channels and a burst of polite
 * announcements must not be able to shed a refusal.
 */
export const LIVE_ANNOUNCEMENT_QUEUE_CAP = 8;

/**
 * How long one announcement stays in its region before the announcer clears it
 * and publishes whatever is queued behind it.
 *
 * Two things fix this window, and they pull in opposite directions. It has to be
 * long enough that assistive technology observes the text before it is replaced —
 * a region mutated and reverted within a frame or two announces nothing at all.
 * And the region has to be CLEARED rather than left standing, because two
 * identical messages in a row are one unchanged string and the second announces
 * nothing; clearing is also what stops a region from re-reading, on a remount, a
 * message the person already heard. So a full lane drains in
 * `LIVE_ANNOUNCEMENT_QUEUE_CAP` × this — seconds, not minutes.
 */
export const LIVE_ANNOUNCEMENT_HOLD_MS = 500;

// ── The terminal family's bounds ──────────────────────────────────────────────
//
// Spent by three different modules under `console/terminal/`, and two of them are
// also read by a test tier that must not construct an emulator to learn a number.
// One of them is spent by that tier ALONE — the width a terminal is measured at —
// and it lives here rather than beside the harness because the budget row's meaning
// depends on it exactly as it depends on the scrollback depth below, and the two
// files that price the row's two halves have to read one number, not two.

/**
 * Lines of scrollback one terminal keeps.
 *
 * `Spec-023 §Console Libraries` records that a buffer line eagerly allocates twelve
 * bytes per cell regardless of content, and §Budgets bounds one pane's retained
 * memory. Ten thousand lines at a working width is the figure that budget was
 * measured at, so moving this moves what the budget means.
 */
export const TERMINAL_DEFAULT_SCROLLBACK_LINES = 10_000;

/**
 * Columns a terminal is driven at when this budget's halves are measured.
 *
 * A buffer line allocates twelve bytes per cell eagerly, so the width is a
 * multiplier on everything the `terminal-instance-memory` row bounds — changing it
 * changes the figure without changing a line of the code being measured. A working
 * width rather than a wide one: the row bounds a terminal someone is using, and a
 * width chosen to make the number small would be measuring a different pane.
 */
export const TERMINAL_BUDGET_MEASUREMENT_COLUMNS = 120;

/**
 * How many terminals may hold a WebGL renderer at once.
 *
 * Chromium keeps sixteen contexts per page and drops the oldest past that, and a
 * disposed addon does not give its context back — so the ceiling is not "how many
 * terminals are open" but "how many contexts this page has ever created". Twelve
 * leaves four for the rest of the page and still covers every layout V1 ships,
 * since 8.8 gives a session exactly one shared shell.
 */
export const TERMINAL_WEBGL_POOL_CAP = 12;

/**
 * How many lease transitions the ledger keeps.
 *
 * The lease changes hands a handful of times in a working session, and the
 * disclosure that renders them is read to answer "who had it, and why did it
 * move" — a question the recent past answers. Bounded rather than unbounded
 * because this list is rebuilt on every fold, and an unbounded one would grow
 * with the session's whole log for a panel that shows the last few lines.
 */
export const TERMINAL_LEASE_LEDGER_CAP = 32;

// ── The embedded browser's position observer ─────────────────────────────────

/**
 * Boxes beside the pane's ancestry whose intrinsic size the position observer
 * watches.
 *
 * The observer covers content-driven layout by watching each SIBLING of the pane and
 * of its ancestors: an auto-sized sibling that grows on a text-node update or a
 * nested insertion moves the pane while no watched box changes shape, no watched
 * attribute changes, and no ancestor's direct child list moves. Nothing else in the
 * module can see that.
 *
 * Bounded because the sibling count is a property of the DOCUMENT, not of the pane. A
 * pane nested inside a live feed has as many siblings as the feed has rows, and an
 * observer per row is the per-row layout cost the attribute observer's own width rule
 * already refuses. Sixty-four covers every layout the console composes with room to
 * spare; past it the NEAREST siblings are the ones observed, because a box beside the
 * pane moves it further than a box beside the document body does, and the remainder
 * stays covered by the five sources that do not depend on this one.
 */
export const POSITION_SIBLING_OBSERVER_CAP = 64;

// ── The embedded browser's settings page ─────────────────────────────────────

/**
 * Partitions the site-data table renders before the rest fold behind a disclosure.
 *
 * `Spec-023 §Console Design (Meridian)` 13.16 fixes the number — "the table folds
 * past ten partitions" — and ten is the point past which a table stops being read
 * and starts being scanned: a node holding more sessions than that has a list, not
 * a table.
 *
 * It lives here rather than beside the page that spends it because a bound declared
 * in a view family is a ceiling nobody audits. `apps/desktop/AGENTS.md` §Config
 * single-sourcing states the rule and `cap-constant-home.test.ts` enforces it, over
 * `_THRESHOLD` as well as `_CAP` and `_MAX`.
 */
export const PARTITION_FOLD_THRESHOLD = 10;

// ── The embedded browser's resource ceiling ───────────────────────────────────
//
// `Spec-023 §Console Design (Meridian)` 12.10: "Make the resource ceiling a named,
// auditable block rather than a set of numbers discovered under load … Every bound
// is a named constant in one module, and every refusal names the constant it hit."
// The block is here; `browser/BudgetMeter.tsx` is the surface that renders it, and
// 12.10's "one place to audit" is this file rather than that component.
//
// Three things the table is careful about:
//
//   • **A bound the console does not own has no number here.** Capture and download
//     bytes are the attachment ingest pipeline's, from
//     `Spec-014 §Bounds (normative defaults; operator-tunable)`; minting a second
//     ceiling would let the two drift, and a row saying so is more useful than a row
//     that is quietly missing.
//   • **A bound that must equal something else IMPORTS it.** `SNAPSHOT_TEXT_MAX` is
//     the event log's content ceiling, so it is that constant rather than a copy of
//     its digits — which is what makes "a snapshot result seals into the content
//     column without truncation" a fact rather than a hope.
//   • **Every figure goes through a chokepoint, and WHICH one is declared here.** A
//     counted ceiling renders through `formatCount` with its unit as a word; a
//     byte-valued one renders through `formatByteQuantity`, the console's single
//     byte-scaling site, in binary units. The unit set below says which of the two a
//     bound is, so the surface dispatches on a declaration rather than deciding for
//     itself — and a `bytes` ceiling printed as a raw decimal figure disagrees with
//     every other byte quantity the console shows.

/**
 * Every bound, by the constant name 12.10 gives it. Closed, and the tuple is the
 * declaration: a refusal has to be able to name the constant it hit, and a name that
 * is not in this set is a number discovered under load.
 */
export const BROWSER_BOUND_NAMES = [
  "PAGES_PER_RUN_MAX",
  "PAGES_PER_SESSION_MAX",
  "PAGES_PER_NODE_MAX",
  "VIEWS_MAX",
  "SESSION_PARTITIONS_MAX",
  "SNAPSHOT_TEXT_MAX",
  "SNAPSHOT_ELEMENTS_MAX",
  "EVALUATE_RESULT_MAX",
  "LOCATOR_RESULT_MAX",
  "CONSOLE_RING_ENTRIES",
  "CONSOLE_ENTRY_MAX",
  "CLIPBOARD_MAX",
  "FULL_PAGE_CAPTURE_MAX",
  "CAPTURE_AND_DOWNLOAD_BYTES",
  "VIEWPORT_DEFAULT",
  "VIEWPORT_MIN",
  "VIEWPORT_MAX",
  "PAGE_OPERATION_TIMEOUT_MS",
  "VIEW_IDLE_TEARDOWN_MS",
  "VIEW_RESIDENT_BUDGET_MB",
] as const;

export type BrowserBoundName = (typeof BROWSER_BOUND_NAMES)[number];

/**
 * Every unit a scalar bound is measured in. Closed, and the tuple is the declaration:
 * the qualifier map below is total over it, so a unit added here does not compile
 * until it has said whether it counts things or measures bytes.
 */
export const BROWSER_SCALAR_UNITS = [
  "pages",
  "views",
  "partitions",
  "elements",
  "entries",
  "bytes",
  "bytes per entry",
  "ms",
  "MB per view",
] as const;

/** One unit a scalar bound carries. Derived from the tuple, never restated. */
export type BrowserScalarUnit = (typeof BROWSER_SCALAR_UNITS)[number];

/**
 * Which chokepoint a unit's figure renders through, and what is left of the unit
 * once it has.
 *
 * `undefined` means the figure is a COUNT: it goes through `formatCount` and the
 * unit rides beside it as a word. A string means the figure is a BYTE quantity: it
 * goes through `formatByteQuantity`, which supplies its own binary unit label, and
 * this is whatever the unit still says after `bytes` has been replaced by the binary
 * unit label — empty for a bare byte ceiling, `per entry` for a per-entry one.
 *
 * A map rather than a predicate over a substring, because "bytes" appearing inside a
 * unit word is a guess and this is a declaration; total over the unit set rather
 * than partial, so the answer cannot be missing for a unit somebody adds.
 */
export const BROWSER_SCALAR_UNIT_BYTE_QUALIFIER: Readonly<
  Record<BrowserScalarUnit, string | undefined>
> = {
  pages: undefined,
  views: undefined,
  partitions: undefined,
  elements: undefined,
  entries: undefined,
  ms: undefined,
  "MB per view": undefined,
  bytes: "",
  "bytes per entry": "per entry",
};

/**
 * How a bound is measured. Three kinds, because three genuinely different things are
 * being said: one number, a pixel box, or "this ceiling belongs to somebody else".
 */
export type BrowserBoundMeasure =
  | { readonly kind: "scalar"; readonly value: number; readonly unit: BrowserScalarUnit }
  | { readonly kind: "extent"; readonly widthPx: number; readonly heightPx: number }
  | { readonly kind: "deferred"; readonly owner: string };

export interface BrowserBound {
  readonly measure: BrowserBoundMeasure;
  /** Why this number and not another. 12.10's derivation column, in its own words. */
  readonly derivation: string;
}

function scalarBound(value: number, unit: BrowserScalarUnit, derivation: string): BrowserBound {
  return { measure: { kind: "scalar", value, unit }, derivation };
}

function extentBound(widthPx: number, heightPx: number, derivation: string): BrowserBound {
  return { measure: { kind: "extent", widthPx, heightPx }, derivation };
}

/**
 * The block. Total over `BrowserBoundName` by construction, so a bound added to the
 * tuple above fails to compile until it has a number and a derivation.
 */
export const BROWSER_BOUNDS: Readonly<Record<BrowserBoundName, BrowserBound>> = {
  PAGES_PER_RUN_MAX: scalarBound(
    8,
    "pages",
    "Eight labelled tabs are what the strip renders legibly at the pane's minimum width; past that the strip stops being an index of what the agent opened.",
  ),
  PAGES_PER_SESSION_MAX: scalarBound(
    24,
    "pages",
    "Three concurrently attached agents at the per-run ceiling.",
  ),
  PAGES_PER_NODE_MAX: scalarBound(
    64,
    "pages",
    "The node ceiling, sized so no single session can starve another.",
  ),
  VIEWS_MAX: scalarBound(
    8,
    "views",
    "One live view per open browser pane; the deck holds no more.",
  ),
  SESSION_PARTITIONS_MAX: scalarBound(
    12,
    "partitions",
    "Resident partitions; the least recently used is evicted, and eviction closes its pages first.",
  ),
  SNAPSHOT_TEXT_MAX: scalarBound(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "The event log's own content ceiling, imported rather than copied, so a snapshot result seals into the content column without truncation and the timeline never has to declare a loss for a browser tool result.",
  ),
  SNAPSHOT_ELEMENTS_MAX: scalarBound(
    500,
    "elements",
    "The interactive-element census past which a snapshot stops being readable by anything.",
  ),
  EVALUATE_RESULT_MAX: scalarBound(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "Same derivation as the snapshot ceiling, and the same constant.",
  ),
  LOCATOR_RESULT_MAX: scalarBound(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "Same derivation as the snapshot ceiling, and the same constant.",
  ),
  CONSOLE_RING_ENTRIES: scalarBound(
    500,
    "entries",
    "One page load's worth of noise plus headroom.",
  ),
  CONSOLE_ENTRY_MAX: scalarBound(
    16_384,
    "bytes per entry",
    "So one stack trace cannot evict the ring.",
  ),
  CLIPBOARD_MAX: scalarBound(8_388_608, "bytes", "Across at most 100 items."),
  FULL_PAGE_CAPTURE_MAX: extentBound(
    4000,
    12_000,
    "Past this a full-page capture is a memory event, not a screenshot.",
  ),
  CAPTURE_AND_DOWNLOAD_BYTES: {
    measure: { kind: "deferred", owner: "the attachment ingest pipeline" },
    derivation:
      "Not a browser bound at all. The attachment ingest pipeline sets this ceiling, and minting a second one here would let the two drift.",
  },
  VIEWPORT_DEFAULT: extentBound(
    1280,
    720,
    "The deterministic box every pointer coordinate must fall inside.",
  ),
  VIEWPORT_MIN: extentBound(320, 240, "The bottom of the viewport override range."),
  VIEWPORT_MAX: extentBound(1920, 1200, "The top of the viewport override range."),
  PAGE_OPERATION_TIMEOUT_MS: scalarBound(
    30_000,
    "ms",
    "The ceiling any tool's own timeout argument may request.",
  ),
  VIEW_IDLE_TEARDOWN_MS: scalarBound(
    120_000,
    "ms",
    "A view whose pane has been closed this long is torn down and its partition released.",
  ),
  VIEW_RESIDENT_BUDGET_MB: scalarBound(
    400,
    "MB per view",
    "Exceeding it for two consecutive samples logs a diagnostic and, on a background view, tears the view down.",
  ),
};
