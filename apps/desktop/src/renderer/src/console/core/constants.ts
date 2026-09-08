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
// A MEASUREMENT IS NOT A BOUND, and that is the line the gates draw. A row height,
// an overscan count, a rounding factor, and an encoding's byte width are sizes and
// factors rather than ceilings — nothing is checked against them — so they stay with
// the code that computes with them, and `console/repos/diff-pane/diff-bounds.ts` is
// the case that says so out loud. `cap-constant-home.test.ts` beside `cap-single-home`
// matches the name segments that make an identifier a ceiling; what comes here is what
// a value is tested against.
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

/**
 * Account-plane notifications held while that registry's OPENING read is in
 * flight.
 *
 * The tail opens before the read, and the read's reply restates the whole
 * registry at an instant the tail has already moved past — so a removal or a
 * credential-generation bump that arrives in that window has to be replayed
 * AFTER the snapshot seats or the snapshot silently undoes it. The buffer's
 * lifetime is therefore one round trip, and its size is whatever the tail bursts
 * inside one: a node's accounts and their limit windows are a handful, so this is
 * a memory bound rather than a policy. Past it the reading stops buffering,
 * applies what it holds live, and takes a FRESH read — nothing is dropped,
 * because the tail emits no second notification for a mutation it already
 * reported.
 */
export const PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP = 64;
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
 * The publisher half is the two bounds below, and both are stated against this one
 * rather than beside it: a receiver that clears at ten seconds is only correct while
 * a still-composing sender refreshes inside that window, so the three numbers are one
 * decision and a reader who moves this one has to see the other two.
 */
export const COMPOSING_RECEIVED_STALE_MS = 10_000;

/**
 * How often a composing sender re-publishes while a person is still typing, in
 * milliseconds.
 *
 * Comfortably under {@link COMPOSING_RECEIVED_STALE_MS}, so a reader's indicator is
 * refreshed twice over before it would expire and one dropped publication does not
 * blink the indicator off a screen the sender is still typing at. It is not smaller
 * than that margin needs: every publication is a wire call, and a keystroke-rate
 * emit would put one on the wire per character for the length of a message.
 */
export const COMPOSING_PUBLISH_INTERVAL_MS = 4_000;

/**
 * How long after the last keystroke a composing sender publishes its own clear, in
 * milliseconds.
 *
 * The sender's stop is an EDGE and the receiver's is a deadline, and this is why both
 * exist: a person who stops mid-sentence to think is not composing, and waiting for
 * the receiver's bound to notice would leave the indicator up for the whole of
 * {@link COMPOSING_RECEIVED_STALE_MS} after they had already stopped. Three seconds
 * is long enough that an ordinary pause between words does not flicker the indicator
 * and short enough that a reader is not told someone is typing when nobody is.
 */
export const COMPOSING_IDLE_STOP_MS = 3_000;

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
 * Attention items the notification emitter remembers having already announced.
 *
 * A bound rather than an unbounded set, because the thing being remembered is a wire
 * id and the projection is re-read for the life of a window: a console left open for
 * a week would otherwise hold every item it ever saw. Two hundred is roughly two
 * orders of magnitude above what a person has open at once, so the oldest id evicted
 * is one whose item cleared long ago — and re-announcing an item that survived an
 * eviction is a duplicate banner, never a lost one, which is the direction this cap
 * is allowed to be wrong in.
 */
export const ATTENTION_NOTIFIED_ITEM_CAP = 200;

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
 * Rows one backward read of a session's log asks the daemon for.
 *
 * The read is registered with its own ceiling — `TIMELINE_READ_LIMIT_MAX`, 256 rows —
 * and this is deliberately well under it, because the two numbers bound different
 * things. That one is the largest window a producer may answer with; this is the
 * largest window a PERSON asked for by pressing a control once, and it lands in a
 * viewport whose own retention is {@link LEDGER_WINDOW_ROW_CAP}. Asking for the wire's
 * ceiling would spend most of a press filling rows the reader then has to scroll past
 * to reach the ones they wanted, and would put three presses over that retention with
 * the prune suppressed underneath them.
 *
 * Fifty is about a screenful and a half at the ledger's density, so one press moves the
 * head far enough to be worth the round trip and near enough that the rows it brought
 * are reachable without a second scroll.
 */
export const LEDGER_EARLIER_PAGE_ROWS = 50;

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

// ── The runs pane's bounds ────────────────────────────────────────────────────
//
// Every one bounds a value the WIRE controls: a session's runs, a run's status
// history, and a session's queue are all as long as the daemon says they are, and a
// surface holding all of any of them would be the unbounded cache
// `Spec-023 §Console Design (Meridian)` forbids in its budget rules. They were
// declared in the runs family beside their readers, which `apps/desktop/AGENTS.md`
// §Config single-sourcing and `cap-constant-home.test.ts` between them do not allow:
// a bound declared in a view family is a ceiling nobody audits.

/**
 * Status rows retained per run.
 *
 * A run's transition history is what the pane's expanded detail reads, and thirty
 * two rows is several minutes of an active run at the rate a driver transitions —
 * far past what a person scrolls back through in a live view, and small enough
 * that a hundred concurrent runs cost thousands of rows rather than millions. The
 * durable record is the session log, which is not this.
 */
export const RUN_STATUS_ROW_CAP = 32;

/**
 * Runs projected from the state stream at once.
 *
 * A session's runs accumulate for as long as the session is open, and terminal
 * runs never leave the stream's history. The oldest-touched run is dropped first,
 * so what survives is what is moving — the reading a live pane exists to give.
 */
export const PROJECTED_RUN_CAP = 200;

/**
 * Rows seated from the session's own record before the remainder is a count.
 *
 * Deliberately well under `PROJECTED_RUN_CAP`, and for a different reason than that
 * bound has. The projection cap bounds a live reading of what is MOVING; these rows
 * are runs the live stream has said nothing about, seated from the session's `run`
 * partition — which is folded from the log, never evicted, and so as long as the
 * session is old. They are appended after every projected row, which puts them at
 * the bottom of a pane that already holds up to two hundred, and each one carries
 * less than a projected row does: no confirmed run version, no status history, no
 * controls. Fifty is past what a person scrolls to at the end of that list, and the
 * order is newest-touched first, so the ones that fall off are the coldest.
 */
export const SEATED_KNOWN_RUN_CAP = 50;

/**
 * Run ids named in the awaiting-projection sentence before the rest is a count.
 *
 * The sentence exists so a person can tell WHICH of the rows in front of them is not
 * live, and that is a lookup: past a handful of ids it stops being one and becomes a
 * paragraph of hex nobody reads. The count still names every run, seated or not, so
 * nothing disappears from the reading — only from the enumeration.
 */
export const AWAITING_RUN_IDS_NAMED_CAP = 6;

/**
 * Intervention outcomes retained.
 *
 * The pane records what it dispatched and what came back; it is not the durable
 * audit record, which lives on the `interventions` table and has no registered
 * read. Sixteen is more than a person issues in one sitting and bounds a list that
 * would otherwise grow for the window's whole life.
 */
export const INTERVENTION_OUTCOME_CAP = 16;

/**
 * Queue rows rendered before the remainder is folded into a count.
 *
 * The cap is spent by a `slice` and a withheld count, which is the whole mechanism:
 * that family windows nothing and imports no windowing layer, so a comment promising
 * virtualization would describe a component that does not exist. Below the cap the
 * list is a plain block; above it the surface says how many rows it is not drawing
 * rather than drawing them all. The queue is FIFO and the head is what matters, so
 * the ceiling truncates the tail and never the front.
 */
export const QUEUE_ROWS_RENDERED_CAP = 50;

// ── The approvals pane's posture chip ─────────────────────────────────────────

/**
 * Allowed domains past which the list is called broad.
 *
 * THE SURFACE'S OWN RULE, because no committed document states it: the copy says a
 * broad allow-list is domain-fronting-weak, and what counts as broad is this number.
 * Eight is the point at which the list stops reading as a named set of endpoints and
 * starts reading as a policy nobody audits row by row — which is exactly when the
 * caveat earns its space, and below which it would be noise on a two-domain
 * allow-list. A threshold over what the daemon SENT, unlike the goal bounds the
 * bridge family holds, which bound what a participant may TYPE.
 */
export const BROAD_ALLOW_LIST_THRESHOLD = 8;

// ── The session goal's length range ───────────────────────────────────────────
//
// `SESSION_GOAL_MAX_LENGTH` is the bound of the two and is what brought them here;
// the minimum came with it on the sidebar range's rule above, because one schema
// clamps between them and a range split across two modules is a clamp a reviewer
// opens two files to check.

/**
 * The shortest a session goal may be.
 *
 * One rather than zero is what makes "an update with no goal is malformed" true at
 * the type level: clearing is a different operation, and an empty-text update is
 * never treated as one.
 */
export const SESSION_GOAL_MIN_LENGTH = 1;

/**
 * The longest a session goal may be.
 *
 * The daemon's own bound, restated so the field refuses on the same rule rather than
 * truncating and sending something the participant did not write.
 */
export const SESSION_GOAL_MAX_LENGTH = 4096;
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

/**
 * Characters of a fetched diff payload the console will parse into a change set.
 *
 * A DIFFERENT BOUND FROM THE ARTIFACT PREVIEW BELOW, AND DELIBERATELY MUCH LARGER. That
 * one bounds how much of a payload a person is SHOWN at once, so a screenful and a half
 * is the right size for it. This one bounds what the parser is handed, and the diff
 * surfaces are virtualized: a five-thousand-line change set renders a viewport's worth
 * of rows however long it is, so cutting the patch at preview size would throw away
 * files a reader can reach rather than text nobody would read.
 *
 * What it is protecting against is the parse itself, which is linear in the patch and
 * happens on the window's own thread. Four megabytes is far past any review a person
 * performs in one sitting — the largest patches in this repository's own history are
 * two orders of magnitude smaller — and a payload past it is a generated artifact rather
 * than a change set. Past the bound the create refuses and says so, because a diff
 * silently missing its last files is worse than one that did not render: the files it
 * dropped are exactly the ones a reader would not know to look for.
 */
export const DIFF_PATCH_CHARACTER_CAP = 4_194_304;

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

// ── The workflows family's bounds ────────────────────────────────────────────

/**
 * Bytes a cancellation reason may occupy, bounded exactly as the engine's own park
 * cause is: eight kibibytes, measured on the UTF-8 encoding rather than on the
 * string's length, because a bound counted in code units refuses a shorter sentence
 * in one script than in another.
 *
 * The unit is spelled out rather than abbreviated on purpose — the console's
 * byte-scaling chokepoint is asserted by scanning every source module for a binary
 * unit LABEL, and a comment carrying one would read as a second byte formatter.
 * Multiplying up to a bound is not scaling down to a display figure.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

/**
 * How far out a long run's phase graph may be zoomed. 0.35 shows roughly three times
 * as many ranks as 1x, which is the point past which the label stops being readable
 * at all — below it the picture is a diagram of nothing.
 *
 * Beside its ceiling rather than beside the canvas because the two are half of a
 * RANGE: a floor and a ceiling are one decision about what the graph is for, and
 * split across two homes one of them moves alone and the range stops meaning
 * anything. The ceiling's name carries a bound's own segment and belongs here on
 * that ground alone; the floor follows it so the decision keeps one home.
 */
export const PHASE_GRAPH_MIN_ZOOM = 0.35;

/**
 * How far in. 1.5 is a reading zoom for a long label, not a design tool's zoom:
 * there is nothing on this surface to inspect at pixel scale.
 */
export const PHASE_GRAPH_MAX_ZOOM = 1.5;

// ── The deep-link invite path's bounds ───────────────────────────────────────

/**
 * How many invitations awaiting confirmation this window holds at once.
 *
 * A bound rather than an unbounded list, because the pending feed's producer is the
 * operating system: every press of an invite link fires the protocol handler again,
 * and a window that queued each one would grow a list nobody is reading for as long
 * as it stays open.
 *
 * DROPPING THE SURPLUS IS RECOVERABLE, WHICH IS WHY A BOUND IS ADMISSIBLE AT ALL. The
 * main process holds each reference until an act releases it, and re-opening the feed
 * re-delivers every one that is still held — so a frame this window declines to queue
 * is not lost, it is simply not on screen yet. Eight is well past any real arrival
 * burst and small enough that the whole queue fits in one reading.
 */
export const PENDING_INVITE_QUEUE_MAX = 8;

/**
 * How many refused previews this window holds BESIDE that queue, waiting for a slot.
 *
 * A SECOND REGISTER BECAUSE THE RECOVERY ABOVE DOES NOT COVER THIS ARM. The bound
 * beside it is admissible because main holds every reference and re-delivers it; a
 * REFUSED preview minted no reference, so main holds nothing for it and replays
 * nothing — deferring one to that replay drops it for the life of the window, and the
 * expired, revoked, or already-accepted explanation a person is owed is gone. So a
 * refusal past the queue's bound is retained here instead and promoted the moment a
 * release makes room.
 *
 * EIGHT, LIKE THE QUEUE, ON A DIFFERENT ARGUMENT. The queue's eight is what fits in
 * one reading; this eight is how many terminal explanations may sit behind a person
 * who has answered nothing at all. Past it the OLDEST retained refusal is dropped
 * rather than the newest turned away: a register that refused new arrivals while
 * holding stale ones would let one burst blind the window to every later refusal,
 * which is worse than losing the oldest of sixteen unread prompts.
 */
export const PENDING_INVITE_RETAINED_REFUSAL_MAX = 8;

/**
 * How many turned-away arrivals keep their place in the order both registers share.
 *
 * THE PLACE AND NOT THE ARRIVAL. Nothing is queued here: main holds the arrival and
 * re-delivers it, and what this bounds is the handle-and-number pair the window
 * remembers so a replayed frame re-enters where it ARRIVED rather than behind
 * everything that arrived while it waited. A bound for the same reason the queue has
 * one — the producer is the operating system — and for one of its own: a place is
 * cleared only when the replay brings its arrival back, which for a reference main has
 * since let go never happens, so nothing here drains on a quiet feed.
 *
 * SIXTEEN, TWICE THE QUEUE, because this register's subject is precisely what did NOT
 * fit in it. One the same width could remember places for no more arrivals than are
 * already on screen, which is the wrong scale for a bound whose whole job is the
 * overflow; twice covers a burst two queues deep, at a handle and a number each.
 *
 * PAST IT THE NEWEST DEFERRAL KEEPS NO PLACE — the opposite disposition from the
 * register above, for the opposite reason. The arrival is still deferred and still
 * replayed, because the debt is recorded either way, so nothing is lost; what it gives
 * up is only its priority against the refusals retained beside it, re-entering as
 * though it had just arrived if the replay finds the queue still at its bound.
 * Dropping the OLDEST place instead would surrender exactly the claim the order exists
 * to protect.
 */
export const PENDING_INVITE_DEFERRED_PLACE_MAX = 16;

// ── The shell's own shutdown budget ──────────────────────────────────────────
//
// It is not here. `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS` is declared in
// `src/shared/shutdown-budget.ts`, because main races the quit drain against the same
// figure the console's restart confirmation quotes, and `src/shared/` is the only home
// both processes can reach. This file's rule — caps live here — governs the console's
// own bounds, and the shell's budget stopped being one the day main became its other
// reader. The door re-publishes it, so a console reader still takes it from `core/`.

/**
 * Run ids named in the restart confirmation before the rest is a count.
 *
 * A SIBLING OF `AWAITING_RUN_IDS_NAMED_CAP` AND NOT THAT CAP. Both bound the same
 * job — ids enumerated in a sentence before the rest becomes a figure — and they are
 * two constants because they bound two different surfaces: that one is a line under
 * a pane that already holds up to two hundred rows, and this one is a paragraph
 * inside a dialog that must be readable in one glance before a person presses a
 * button they cannot take back. Sharing one number would tie the width of a
 * consequence sentence to the width of a pane's footnote, and the day either moves
 * the other would move with it for no reason anybody could state.
 *
 * Three rather than six for exactly that reason: past a few ids the enumeration
 * stops being a lookup and becomes hex the reader skips, and what a person is
 * deciding here is answered by the COUNT — which names every moving run, seated or
 * not, so nothing disappears from the reading.
 */
export const INTERRUPTED_RUN_IDS_NAMED_CAP = 3;

/**
 * How long a run must have been making no progress before the console says so.
 *
 * The daemon decides whether a run is stuck — `health.stuckRunInspect` answers
 * `stuck-suspected` or `healthy`, and this console composes neither. What this bound
 * governs is the SENTENCE beside that answer: below it the quiet interval is not worth
 * a figure on screen, because a run between two tool calls is ordinarily quiet for a
 * few seconds and a surface that reported every one of them would report nothing.
 *
 * Sixty seconds because that is the threshold the design names for the badge
 * appearing at all, and stating it once here is what keeps the console's reading of
 * "quiet" from being one number in a component and another in its test.
 */
export const STUCK_RUN_NOTICE_MS = 60_000;

/**
 * How long that quiet has to last before the same badge escalates its presentation.
 *
 * Five minutes, and it changes the badge's TONE and its sentence — never its verdict,
 * which stays the daemon's. A run quiet for six minutes and one quiet for seventy
 * seconds are both `stuck-suspected` to the daemon and are not the same thing to a
 * person deciding whether to interrupt, and this is the whole of the difference the
 * console is allowed to draw between them.
 *
 * A SIBLING OF THE NOTICE BOUND AND NOT A MULTIPLE OF IT. The two are read from the
 * same design sentence as two independent thresholds, and deriving one from the other
 * would make the ratio the thing a later change has to preserve rather than the two
 * durations a reader can check against the design.
 */
export const STUCK_RUN_ESCALATION_MS = 300_000;

/**
 * The full-scale value a utilization bar is drawn against, and the clamp on its fill.
 *
 * A quota reading can exceed its own limit — a provider that admitted a request over
 * an allowance still reports what was spent — and an unclamped `<progress>` fill past
 * its `max` renders as a full bar in one engine and an overflowing one in another. So
 * the BAR is clamped and the FIGURE beside it is not: the bar answers "how full", which
 * saturates, and the percentage answers "how much", which does not. Clamping both
 * would hide an overage; clamping neither would draw one wrong.
 *
 * One rather than a hundred because the fraction is what `Intl` takes for a percent,
 * so the same number serves the bar's scale and the figure's input and there is no
 * second unit anywhere on the row to get backwards.
 */
export const UTILIZATION_BAR_FULL_SCALE = 1;

// ── The load hairline's progress range ───────────────────────────────────────
//
// `LOAD_PROGRESS_MAX` is the bound of the two and is what brought them here; the
// floor came with it on the sidebar range's rule above, because the hairline clamps
// between them on every paint and a range split across two modules is a clamp a
// reviewer opens two files to check.

/**
 * The floor of a reported load fraction.
 *
 * Zero rather than a hair above it: a load that has genuinely reported nothing yet is
 * a zero-width fill, and a floor that painted a sliver would be the renderer claiming
 * progress the view did not report.
 */
export const LOAD_PROGRESS_MIN = 0;

/**
 * The ceiling. The fraction crosses a boundary this window does not own, and a value
 * past one would paint a fill wider than its track and hand an assistive technology a
 * percentage above a hundred.
 */
export const LOAD_PROGRESS_MAX = 1;
// ── The browser pane's shelf rows ────────────────────────────────────────────
//
// Two display bounds over renderer lists, and NEITHER is one of the browser
// subsystem's resource ceilings — those live in `browser/bounds/browser-bounds.ts`
// and are the daemon's. Nothing is refused, truncated, or deleted because of these:
// what is dropped is a row nobody scrolled to.

/**
 * How many relayed agent tool calls the pane's shelf holds at once.
 *
 * Twelve is what fits inside an open disclosure without turning the overflow control
 * into a scroll region of its own. It bounds a renderer list and nothing else: not
 * what the daemon relays, not what an agent may call, not what the timeline records.
 */
export const RELAYED_TOOL_CALL_ROW_CAP = 12;

/**
 * How many of a pane's own captures keep a card.
 *
 * The same twelve, and deliberately the same number rather than a second one: the two
 * lists render into the same disclosure and a shelf whose halves cut off at different
 * depths reads as one of them having lost rows.
 */
export const CAPTURED_OBJECT_ROW_CAP = 12;
