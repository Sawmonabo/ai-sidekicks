// The console's named bounds.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// This module is that place, and it is the ONLY one: a bound declared in a view
// family is a ceiling nobody audits, so every cap, window, and timeout a view
// family spends is declared here and imported through `core/index.ts`.
// `apps/desktop/AGENTS.md` §Config single-sourcing states the rule and
// `test/console/architecture/cap-constant-home.test.ts` enforces it, over
// `_THRESHOLD` and `_LIMIT` as well as `_CAP` and `_MAX`.
//
// A MEASUREMENT IS NOT A BOUND, and the line is the one that gate draws. A row
// height, an overscan count, a rounding factor, and an encoding's byte width are
// sizes and factors rather than ceilings — nothing is checked against them — so
// they stay with the code that computes with them. What comes here is what a
// value is tested against.
//
// A number that appears inline anywhere under `console/` and is not a layout
// literal is a review rejection: the rationale is the point, not the constant.

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

// --- Attachment ingest ----------------------------------------------------
//
// `Spec-014 §Bounds (normative defaults; operator-tunable)` registers all four of
// the bounds below on the wire, and the daemon is what enforces them; the console
// carries them so it can explain a bound ahead of the refusal rather than after
// it. Each mirrors its registered source EXACTLY and is never looser — a console
// that admitted more than the daemon would spend a participant's upload to earn a
// refusal. Three are operator-tunable, so every surface that shows one says
// "default" until `artifactAllowlistRead` answers with the effective value; the
// chunk size is fixed because the frame ceiling it derives from is.

/**
 * Decoded bytes one attachment may carry, at the shipped default.
 *
 * `max_attachment_ingest_bytes`, deliberately equal to the per-artifact relay cap
 * so an accepted attachment is relay-pinnable by construction. Operator-tunable
 * between one megabyte and one gigabyte.
 */
export const ATTACHMENT_BYTE_CAP_DEFAULT: number = 100 * 1024 * 1024;

/**
 * Attachments one carrier may name, at the shipped default.
 *
 * `max_attachments_per_carrier`, derived from the quota envelope rather than
 * picked: one maximally-sized carrier exactly saturates the per-session relay
 * budget. Operator-tunable over a 1 – 50 range. Bound on the CARRIER and never on
 * an ingest stream, which carries exactly one payload and has no count to cap.
 */
export const ATTACHMENTS_PER_CARRIER_CAP_DEFAULT = 10;

/**
 * Decoded bytes in one chunk. Fixed, not operator-tunable.
 *
 * `max_attachment_chunk_bytes`: the largest raw chunk whose RFC 4648 base64 form
 * plus the JSON-RPC envelope fits the frame ceiling `MAX_MESSAGE_BYTES` declares
 * in `packages/contracts`. The ceiling it derives from is not tunable, so neither
 * is this, and the arithmetic is asserted rather than trusted.
 */
export const ATTACHMENT_CHUNK_BYTE_CAP: number = 512 * 1024;

/**
 * Wall-clock ceiling on one ingest stream, measured from its first call.
 *
 * `max_ingest_stream_lifetime`. The abandoned-spool reaper clocks file
 * modification time, which a trickle of chunks refreshes forever, so live-stream
 * tenure needs its own clock. Surfaced on a stalled upload because it is the one
 * bound whose expiry a participant cannot otherwise see coming. Operator-tunable
 * over a 1 – 24 hour range.
 */
export const INGEST_STREAM_LIFETIME_CEILING_MS: number = 6 * 60 * 60 * 1000;

/**
 * Silence after which an in-flight upload discloses the stream ceiling.
 *
 * The console's own, with no wire source: the daemon enforces the ceiling and
 * says nothing about when a person should be told it exists. A minute — long
 * enough that a chunk round trip on a slow uplink is not called a stall, short
 * enough that a participant learns the stream is bounded while there is still
 * time to act on it, which is why it has to sit far inside the ceiling itself.
 */
export const INGEST_STALL_DISCLOSURE_MS = 60_000;

/**
 * Bytes one `String.fromCharCode` call converts on the way to base64.
 *
 * Not a policy bound — a call-stack one. That function takes its bytes as
 * ARGUMENTS, so a spread of a whole chunk-capped slice overflows the stack on
 * every engine; eight kilobytes is comfortably inside the limit every one of
 * them documents while keeping the loop short enough that the rope it builds
 * costs nothing measurable.
 */
export const BASE64_ENCODE_STRIDE_BYTES: number = 8 * 1024;

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

// ── The diff surfaces ────────────────────────────────────────────────────────

/**
 * How tall an inline diff card is before it offers to grow.
 *
 * `Spec-023 §Meridian, the design language` rule 7 puts diff cards in the timeline at
 * "a height cap and then offer 'show all'", and `InlineDiffCard.tsx` has the card open
 * EXPANDED to that cap rather than collapsed. The figure is about fifteen rows —
 * a hunk's worth of reading, which is what makes the card useful in place — while
 * still leaving the turn that produced it visible above and below.
 */
export const INLINE_DIFF_CARD_HEIGHT_CAP_PX = 300;

/**
 * Files a change set may hold before the file list virtualizes rather than
 * rendering every row.
 *
 * The file list is a different scroller from the row list and is bounded by the
 * change set rather than by the diff's line count, so it gets its own bound. Past
 * this the list is long enough that a person filters instead of scanning, which
 * is why the filter sits above it and not behind a disclosure.
 */
export const DIFF_FILE_LIST_SCROLL_THRESHOLD = 12;

/**
 * The longest line an intraline word diff is computed for, in characters.
 *
 * jsdiff's word diff is O(n·m) in TOKENS, so the cost of one pair grows with the
 * PRODUCT of the two lines' lengths and not with their sum. A line past this bound is
 * a minified bundle, a vendored data row, or a lockfile entry — text a word-level
 * highlight does not help anybody read — and computing one costs more than the whole
 * rest of the change set: a single 18,889-character pair inside a 5,000-line patch
 * measured 831 ms on its own (2026-09-02). Past the bound the row keeps its whole-line
 * highlight and says so, rather than the renderer stalling on it.
 */
export const DIFF_INTRALINE_LINE_CHARACTER_CAP = 2_000;

/**
 * The largest product of a pair's two line lengths an intraline diff is computed for.
 *
 * The cap above bounds ONE line; this one bounds the pair, which is what the algorithm
 * is actually quadratic in — two 1,000-character lines are each admissible and their
 * comparison is not. Stated as the product rather than as a second length so the bound
 * is the same quantity the cost is.
 */
export const DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP = 1_000_000;

/**
 * Computed intraline segmentations held before the oldest is dropped.
 *
 * Intraline is computed when a row is materialised, so a reader who scrolls a
 * five-thousand-line change set end to end would otherwise accumulate one segment list
 * per changed line and hold them for as long as the diff is open. A viewport plus its
 * overscan is tens of rows; this holds several screens of scrollback, so scrolling back
 * up is free while retention stays a function of the cap rather than of the diff.
 */
export const DIFF_INTRALINE_CACHE_ENTRY_CAP = 512;

// ── The artifact pane and the rollback disclosure's path enumerations ─────────

/**
 * Characters of a fetched artifact payload the pane will draw at once.
 *
 * A RENDERER bound and not a wire one, so it is picked here rather than mirrored
 * from a contract: an inline payload arrives whole and the pane has to decide how
 * much of it a person is shown before scrolling a hundred-megabyte log becomes the
 * surface's whole cost. Two thousand characters is a screenful and a half at the
 * console's mono measure — enough to recognise what a payload IS, which is what the
 * preview is for, and far short of the point where a single text node degrades
 * layout. Truncation is always reported beside the text; the preview never silently
 * shortens what it drew.
 */
export const ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP = 2_000;

/**
 * Paths one open enumeration renders in full before it windows instead.
 *
 * Below the bound the whole list is shorter than the window a scroll container
 * would give it, so windowing would add a scrollbar, a focus stop, and a measured
 * row for no reduction in nodes. At and above it the list is longer than any pane
 * is tall, and every row past the fold is a node nobody has looked at yet.
 */
export const RESTORE_PATH_VIRTUALIZATION_THRESHOLD = 50;

/**
 * Rows one windowed enumeration shows at once.
 *
 * A dozen paths is enough to read a group of them as a group — which is what an
 * operator is doing when they open this list at all — while keeping the container
 * short enough that the disclosure it sits inside does not become the whole pane.
 */
export const RESTORE_PATH_VISIBLE_ROW_CAP = 12;

/**
 * The height one path row is estimated at, in CSS pixels.
 *
 * An ESTIMATE and not a contract: rows measure themselves once rendered, so a
 * wrapped path is placed at the height it turned out to be. It is here because the
 * window's own height cap is this times the visible-row cap, and a first paint
 * happens before any row has been measured — so the estimate is what decides how
 * many rows that first paint asks for.
 */
export const RESTORE_PATH_ROW_HEIGHT_PX = 20;

/** The tallest a windowed enumeration's scroll container may grow, in CSS pixels. */
export const RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX: number =
  RESTORE_PATH_VISIBLE_ROW_CAP * RESTORE_PATH_ROW_HEIGHT_PX;
