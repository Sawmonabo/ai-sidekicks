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
// WITH ONE SHAPE THE GATE DECIDES, and it decides against the sentence above.
// `test/console/architecture/cap-constant-home.test.ts` reads DECLARATIONS, names
// this module the one a bound may be declared in, and fails a view family that
// declares one of its own. So a family's bound TABLE — a record keyed by the names
// it declares in one tuple, which is what `browser/bounds/browser-bounds.ts` is —
// stays beside its readers, while a plain `export const SOMETHING_CAP = …` lands
// here whichever family spends it. The rationale travels with the value: each block
// below carries the paragraph it was written with, and the family module it left
// says what went and why.
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
 * The number is a decision `Spec-023 §Meridian, the design language` rule 7 already
 * fixed — "the cast bar shows up to eight chips, then `+N`" — and a bound re-derived
 * at the point of use is a bound that can come back different.
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

// The ledger cards' bounds. Spent under `ledger/cards/` and `ledger/markdown/`,
// declared here because `cap-constant-home` allows a bound exactly one declaring
// module; what stays beside those readers is the layout and lag figures that are
// not ceilings.

/**
 * Bytes of parsed-block cache the renderer retains, across every card.
 *
 * Bounded in bytes rather than in entries because the entries are markdown blocks and
 * their sizes span four orders of magnitude: a thousand one-line paragraphs and one
 * pasted file are the same entry count and not the same memory. Two mebibytes is
 * several long conversations' worth of settled prose at the ledger's density, and it
 * is charged against the source text rather than the node tree because the source is
 * what the cache is keyed by and the only figure it can measure without walking.
 */
export const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;

/**
 * SOURCE bytes of highlighted code the token cache holds, across every code block.
 *
 * `Spec-023 §Console Libraries`, syntax-highlighting row: "byte-bounded token cache".
 * The bound is in source bytes because that is what `byte-bounded-cache.ts` charges —
 * it measures the KEY, which is the block's own text, for the reason its header gives:
 * a node tree's retained size cannot be had without walking it. So this figure is sized
 * with the retained tokens in mind rather than stated in them. That row's measurement is
 * 21.5x, and one mebibyte of retained tokens divided by it is about 48,771 source bytes;
 * 48,000 is that rounded down, so the tokens stay INSIDE the mebibyte rather than a
 * little past it. It is a screenful of fenced blocks in scrollback, and far below the
 * point where retaining them costs more than re-tokenising them.
 *
 * THE CONSEQUENCE, NAMED RATHER THAN LEFT TO BE FOUND: a block between this cap and
 * `CODE_HIGHLIGHT_SOURCE_BYTE_CAP` is highlighted and NOT cached, because the cache
 * drops an entry larger than the whole cap rather than evicting everything else to hold
 * it. That is exactly what the highlight-source cap's own rationale below asserts, and
 * it is only true while this figure is stated in the units the cache charges.
 */
export const CODE_TOKEN_CACHE_BYTE_CAP = 48_000;

/**
 * Source bytes above which highlighting leaves the main thread.
 *
 * `Spec-023 §Console Libraries`: "in a Worker above about 4 kB of source". The row's
 * own measurement is the reason — the JavaScript engine costs about 8.1 ms per 2,700 bytes,
 * so 4,096 bytes is the last size whose tokenisation still fits inside one 16.7 ms frame
 * beside the layout it has to leave room for.
 */
export const CODE_WORKER_THRESHOLD_BYTES = 4096;

/**
 * Source bytes above which a code block is not highlighted at all.
 *
 * The worker keeps a large block off the main thread; it does not make the block
 * cheap. Past a quarter mebibyte the tokens cost more than the whole retained cache
 * and the block is prose to the reader either way, so it renders as plain mono text
 * and says so — which is the honest reading of `Spec-023 §Console Design (Meridian)`
 * rule 8's "an absence names its cause" applied to a capability rather than to a row.
 */
export const CODE_HIGHLIGHT_SOURCE_BYTE_CAP = 262_144;

/**
 * Footnote definitions one timeline's registry retains.
 *
 * This console keeps one popover host per timeline with a definition registry keyed by
 * source — `markdown/footnote-registry.ts` states why. Bounded for the reason every cache in the
 * console is: a definition belongs to the message that carried it, and a log holds
 * `LEDGER_WINDOW_ROW_CAP` rows, so a few definitions per retained row is the whole
 * reachable population and nothing above it can ever be opened.
 */
export const FOOTNOTE_DEFINITION_CAP = 2048;

/**
 * Characters of a tool row's one-clause summary before it is elided.
 *
 * `Spec-023 §Meridian, the design language` rule 7: "Tool rows render as one line until
 * opened." What that one line carries — glyph, tool name, a one-clause summary, elapsed,
 * and the result state — is this console's own composition; the line is the constraint,
 * and at the ledger's measure and mono figure column this is what fits beside the name
 * and the elapsed without wrapping.
 */
export const TOOL_SUMMARY_MAX_CHARACTERS = 96;

/**
 * ANSI chunks one command-output body renders before the rest is folded away.
 *
 * `anser` yields one entry per style run, so a colour-heavy build log produces far more
 * entries than lines. The cap is on the mapped spans rather than on the source bytes
 * because the spans are what become DOM nodes.
 *
 * IT IS THE FIRST RENDER'S CAP AND NOT THE BLOCK'S CEILING. `Spec-023 §Console Design
 * (Meridian)`'s "#### Rules every console surface obeys" is why: the fold has to be
 * recoverable, and `AnsiOutput` is what makes it so — the notice carries both figures
 * and a control that re-parses the same source under a cap that admits every run. A cap
 * with no way past it would put the tail of a colour-heavy command beyond reach, since
 * reopening the card re-parses exactly the same capped sequence.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;

// The ledger frame's bounds — the window, the element ceiling, and the reveal
// engine's per-frame budget. Spent inside `ledger/frame/`.

/**
 * Top-level rows the ledger window retains before the oldest are pruned.
 *
 * A ceiling rather than a nicety: Chromium caps an element's height at
 * `LEDGER_MAX_ELEMENT_HEIGHT_PX`, so an uncapped log eventually renders rows the
 * browser cannot place. Four hundred rows is several screens of scrollback at the
 * ledger's density, which is as far back as a person reads before reaching for
 * find or the rail.
 */
export const LEDGER_WINDOW_ROW_CAP = 400;

/**
 * Chromium's maximum element height, in CSS pixels.
 *
 * The reason the window is a cap and not an optimisation: past this a virtual
 * list's total-size spacer stops growing and every row below it is unreachable.
 */
export const LEDGER_MAX_ELEMENT_HEIGHT_PX = 33_554_431;

/**
 * Characters the reveal engine publishes per frame, across every lane.
 *
 * Sized to the frame budget rather than to reading speed: at 60 Hz this is roughly
 * 28,000 characters a second, which outruns every provider's output while leaving
 * the frame's remaining time to layout. The per-lane share is this figure divided
 * across the lanes that have work, so four lanes each advance every frame instead
 * of one lane finishing while three wait.
 */
export const REVEAL_FRAME_CHARACTER_BUDGET = 480;

/**
 * Checkpoints a lane retains for its authoritative commits.
 *
 * The tail is bounded because a checkpoint exists to re-anchor a commit that
 * arrived out of band, and a commit older than a few frames is one the engine has
 * already published past. Eight frames of history is a tenth of a second.
 */
export const REVEAL_CHECKPOINT_TAIL_CAP = 8;

/**
 * Pruned rows whose leased state the window parks under a synthetic key.
 *
 * Bounded for the reason every cache in the console is: a person who pages back
 * expects the row they had open to still be open, and nobody expects that of a row
 * pruned an hour ago. Parking one window's worth covers a page back and no more.
 */
export const LEDGER_PARKED_LEASE_CAP = 400;

/**
 * How far the reveal gate walks back from a candidate ceiling looking for a
 * literal-safe stopping point.
 *
 * Bounded because a run of volatile characters — a rule of asterisks, a table
 * border — would otherwise make the walk proportional to the block's length on
 * every frame. Eight characters covers every incomplete construct the gate can
 * withhold (a fence, a link opener, an emphasis run) and refuses to become a scan.
 */
export const REVEAL_LITERAL_BACKTRACK_CAP = 8;

// The ledger structure's bounds — the chapter, the rail's two painting ceilings,
// and the find walk. Spent inside `ledger/structure/`.

/**
 * Rows a single chapter renders before its body clips.
 *
 * The cap on a chapter's visible rows, held here rather than inside the fold so the
 * bound sits beside the rest of the structure family's. A chapter is a nested scroller, so the
 * cap is not about what fits on screen — it is about how many rows one run may
 * mount at once while three sibling runs stream beside it. 120 is four screens of
 * ledger at this density: enough that scrolling inside a chapter is reading
 * rather than paging, and far short of the point where four live chapters cost a
 * frame.
 */
export const CHAPTER_VISIBLE_ROW_CAP = 120;

/**
 * The widest a tick grows at the centre of the fisheye. Past roughly three the
 * magnified band stops reading as the same rail and starts reading as a second
 * control.
 */
export const RAIL_FISHEYE_MAX_SCALE = 2.6;

/**
 * Ticks the rail paints per column of ink.
 *
 * The rail draws the loaded window, which the ledger's own timeline cap already
 * bounds; this is the second bound, and it is a painting bound rather than a data
 * one — past one tick per pixel the marks overdraw and the minimap stops being a
 * map. Ticks beyond it are folded into the nearest painted column, never dropped.
 */
export const RAIL_MAX_TICKS_PER_PIXEL = 1;

/**
 * Matches the find field ranks and offers next/previous over.
 *
 * The field searches the loaded window, and a query of one character matches most
 * of it; past this the count stops being a number a person acts on and the
 * next/previous walk stops terminating in a session. The cap bounds the walkable
 * set, so the counter's denominator is that set and the true match count rides
 * beside it as a second figure — a denominator naming matches no press can reach
 * is a promise the walk cannot keep.
 */
export const FIND_MATCH_CAP = 500;

// The workspace's two bounds. The rest of that family's figures are widths, a
// density table, and defaults, which are not ceilings and stay beside their readers.

/**
 * Panes one saved deck layout may restore.
 *
 * This family's own decision, like the third of the three restore rules
 * `deck/deck-snapshot.ts` states — no committed document fixes the number, and the cap
 * is about untrusted input rather than performance: a persisted record is a file on
 * disk, and without a bound a corrupted or hand-edited one mounts panes until the
 * window stops responding. Twelve is past any arrangement a person builds on a display
 * the density presets below are drawn for, so the cap binds a defect and never a
 * session.
 */
export const DECK_RESTORED_PANE_CAP = 12;

/**
 * The widest the sidebar may be kept at, in percent.
 *
 * DERIVED FROM THE DECK, not chosen for the sidebar: the deck is the side whose own
 * density floor is measured in pixels, and forty percent is the share that still
 * leaves a two-pane deck above its preset's minimum on the narrowest window the
 * presets are drawn for. So it is written here as the sidebar's ceiling and read from
 * here as the deck's floor, rather than declared twice at two ends of one band and
 * left to agree by inspection.
 */
export const SIDEBAR_MAXIMUM_WIDTH_PERCENT = 40;
