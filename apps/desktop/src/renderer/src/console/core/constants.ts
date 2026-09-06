// The console's named bounds. All of them.
//
// `Spec-023 §Console Design (Meridian)` §The four bars, "Light on the machine":
// "Every cap, window, and timeout is a named constant with a one-line rationale".
// `apps/desktop/AGENTS.md` says where: "One value, one home: budgets and their unit
// factors in `budgets.json`, caps in `console/core/constants.ts` with a rationale
// each."
//
// ONE HOME MEANS ONE HOME. This file used to say a view family adds its own module
// beside its subtree, and four families took that licence — `agents/constants.ts`,
// `collaboration/constants.ts`, `sessions/bounds.ts`, `settings/constants.ts` — so a
// cap audit's answer depended on which of five places it looked in, and a bound was
// spelled `constants` in three of them and `bounds` in the fourth. Every bound lives
// here now, and `test/console/architecture/cap-single-home.test.ts` fails the build
// if a second home appears.
//
// GROUPED BY WHO SPENDS IT, banner-commented, appended within a group. The rationale
// travels with the value: a bound moved here without the paragraph that says why it
// is that number is a number, and a number is what this file exists to prevent.
// `core/` is the bottom of the family DAG, so every family may import from it and no
// family crosses another to reach a bound.
//
// A number that appears inline anywhere under `console/` and is not a layout
// literal is a review rejection: the rationale is the point, not the constant.

// ----------------------------------------------------------------- the substrate

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

/**
 * The longest identifier the persistence grammar admits. A UUID is 36 characters
 * and a namespaced command id is well under this; prose is not.
 *
 * Held to by two boundaries rather than one — the durable value walk and the pane
 * address parse — which is why it is a bound with a home and not a literal beside
 * either of them.
 */
export const IDENTIFIER_MAX_LENGTH = 128;

/**
 * Live composer drafts one window holds before the oldest is evicted.
 *
 * More composers than a person has open, and still bounded: drafts are held in
 * memory and never persisted, so the ceiling is what keeps a long session's
 * abandoned text from growing without limit. It is supplied to `DraftStore` by the
 * frame rather than defaulted inside it, because that module imports nothing at all
 * — `draft-non-persistence.test.ts` asserts the zero, since acquiring anything there
 * is the first move of persisting a draft.
 */
export const MAXIMUM_LIVE_DRAFT_COUNT = 64;

/** Commands the palette remembers. Enough to cover a working session's rhythm. */
export const PALETTE_RECENTS_CAP = 8;

/**
 * Ranked results the palette renders at once. The list is keyboard-walked, so
 * past this a person is scrolling rather than choosing and should refine instead.
 */
export const PALETTE_RESULT_CAP = 40;

/**
 * Rows a bounded enumeration shows before it scrolls.
 *
 * Six, and the number is a ceiling rather than a preference. The shortest window
 * the console ships is 720 px tall (the agent-console auxiliary geometry), which is
 * 45 rem at the 16 px root; an enumeration allowed to take more than a third of
 * that would leave the surface holding it with nothing else on screen. Six rows is
 * 13.875 rem and clears that third; seven is 16.1875 rem and does not. The rem
 * height itself is the token family's, because it is this count multiplied by a row
 * height the type and space scales decide.
 */
export const BOUNDED_ENUMERATION_MAX_ROWS = 6;

/**
 * Maximum nesting depth of a keybinding when-clause. Bounded so a malformed or
 * hostile expression cannot recurse the parser; past the bound the clause is
 * refused and the binding evaluates false, which is the fail-closed arm.
 */
export const WHEN_CLAUSE_MAX_DEPTH = 8;

/**
 * Distinct context keys a pair of when-clauses may name before
 * `whenClausesCanOverlap` stops enumerating.
 *
 * Twelve keys is 4096 assignments per pair, checked only for bindings that share a
 * chord — microseconds, once, at install. It is set by what a human writes: a
 * console clause names two or three keys, and a pair naming thirteen is a design
 * smell long before it is a performance problem.
 */
export const WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS = 12;

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

// ---------------------------------------------------------------- the agents family

/**
 * Tool names rendered from a resolved allowlist before the list folds to a count.
 *
 * The allowlist is a snapshot taken at attach and can be long. Past this many names
 * the line stops telling a reader what the agent may do and starts being a wall, and
 * the useful residual fact is how many more there are.
 */
export const TOOL_ALLOWLIST_NAMED_CAP = 6;

/**
 * Characters of a resolved instruction or goal rendered inline before it clamps.
 *
 * Both are free prose an operator wrote and either may be pages. The echo's job at
 * the point of confirmation is to prove the daemon resolved what was asked, which a
 * leading passage does; the whole text belongs to the definition editor, which is
 * another plan's body.
 */
export const RESOLVED_PROSE_INLINE_CAP = 240;

// --------------------------------------------------------- the collaboration family

/**
 * How long a human's composing indicator survives without a refresh, in
 * milliseconds.
 *
 * The receive half of the bound `Spec-023 §Console Design (Meridian)`'s
 * collaboration section states. It sits well inside the thirty-second Awareness
 * staleness window, so an indicator is gone from the screen long before the
 * protocol would garbage-collect the client that wrote it.
 *
 * The publisher half is deliberately absent: no surface in this console emits a
 * composing signal, because no transport carries one, and a bound spent by nobody
 * is a number that would go stale unread before its first reader arrived. It lands
 * beside the emitter, in the change that adds one.
 */
export const COMPOSING_RECEIVED_STALE_MS = 10_000;

/**
 * Concurrent composers rendered by name before the line folds to a count.
 *
 * Above three the line stops being information and starts being motion: the names
 * churn faster than they can be read, and what a person actually wants from a
 * fourth composer is the fact that the room is busy.
 */
export const COMPOSING_NAMED_CAP = 3;

/**
 * Settled invitations the sent-invite ledger renders inside its one disclosure.
 *
 * Sixteen. The fold exists because accepted, expired, and revoked rows are history
 * rather than work, and history that outgrows one screenful stops being scannable
 * and becomes a log — which is the timeline's job, not this section's. A sender who
 * needs more than this is asking a question the ledger cannot answer, because no
 * invite read carries a cursor to page with.
 */
export const SETTLED_INVITE_VISIBLE_CAP = 16;

// -------------------------------------------------------------- the sessions family

/**
 * Back-tier rows the all-sessions list shows before folding the rest under a
 * count (the design's density rule: "the back tier folds to a count when it
 * exceeds the visible budget").
 *
 * Five, because the back tier is the demoted half of the list and its job is to
 * stay reachable without competing with the front tier for the same screen. A
 * taller budget makes the divider stop meaning anything; a shorter one folds a
 * tier that had barely begun.
 */
export const SESSION_BACK_TIER_VISIBLE_CAP = 5;

/**
 * Invitations the shelf remembers a person set aside.
 *
 * Bounded because the hide set is a durable cache and an unbounded cache is a
 * store that grows for as long as the install lives. Sixty-four is generous
 * against the shape of the thing — an invitation is a rare, expiring object, and
 * a person with more than this many set aside has a different problem — and the
 * set is pruned against every served read besides, so the cap is the second line
 * of defence rather than the first.
 */
export const HIDDEN_INVITE_CAP = 64;

// -------------------------------------------------------------- the settings family

/**
 * Mounts a settings inventory reads in full before it stops naming them.
 *
 * The mount inventory is composed from two reads — the session's workspace list
 * names the mounts, and each mount is then read for its path and its health — so
 * the second read's cost is one call per distinct mount. Twenty-four is far above
 * any session a person assembles by hand and low enough that a session with a
 * pathological mount count cannot turn one settings visit into an unbounded fan-out.
 * Past it the page names how many mounts it did not read rather than hiding them,
 * because a silently truncated inventory is the one thing worse than a long one.
 */
export const MOUNT_INVENTORY_READ_CAP = 24;

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
