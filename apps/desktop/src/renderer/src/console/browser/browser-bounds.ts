// The embedded browser's resource ceiling.
//
// `Spec-023 §Console Design (Meridian)` 12.10: "Make the resource ceiling a named,
// auditable block rather than a set of numbers discovered under load … Every bound
// is a named constant in one module, and every refusal names the constant it hit."
// The block is here; `BudgetMeter.tsx` beside it is the surface that renders it, and
// `bound-figures.ts` is how a figure is spelled.
//
// WHY IT LIVES IN THE FAMILY AND NOT AT THE DAG FLOOR. `core/constants.ts` says it in
// its own header — "each view family adds its own module beside its subtree rather
// than widening this one, so a bound always sits next to the code that spends it" —
// and this is that module. What sat in `core/` was not a set of ceilings: it was a
// bound TAXONOMY, a unit tuple, a byte-qualifier dispatch table, two constructor
// functions, and a twenty-row table of prose derivations, none of which anything
// outside this family reads, and one of which — the qualifier map — encodes which
// `primitives/` chokepoint a browser figure renders through, two layers above the
// module that was declaring it. It was down there because the cap gate matched an
// object-literal key by its indentation and a tuple member by its quotes, so the only
// placement the gate would accept was the one the layering rule argues against. The
// gate reads declarations now, and the block sits where its readers are.
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

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";

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
