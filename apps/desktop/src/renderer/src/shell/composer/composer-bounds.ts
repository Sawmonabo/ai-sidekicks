// The composer family's named bounds.
//
// The console keeps its own caps at its floor, one module per concern, in
// `console/core/constants/`, per the config single-sourcing rules in
// `apps/desktop/AGENTS.md`. The shell is not a console family and has no module there,
// so this is that module for the composer, and it exists for the same reason the
// console's do: a number that appears inline is a decision nobody wrote down.
//
// Each bound below is spent by exactly one module today. They live here rather than
// in those modules because the next zone to want one would otherwise copy it, and two
// copies of one ceiling drift in the direction nothing catches.

/**
 * Sent messages the directive line's history recall walks.
 *
 * A recall list is a convenience, not an archive — the ledger is the archive. Deep
 * enough to reach the message before last after a correction and a retry, shallow
 * enough that ArrowUp stays a gesture rather than a search. Past this the person is
 * looking for something and the ledger is what they should be looking in.
 */
export const COMPOSER_HISTORY_RECALL_CAP = 20;

/**
 * Composer addresses whose recall history one window retains.
 *
 * History is per address, so re-addressing the composer never walks another
 * target's sent messages into this line — and coming back to an address finds its
 * own history intact, which a reset on every rebinding would have destroyed. That
 * makes the map grow with the addresses a person visits, and a window left open all
 * day visits many, so the least recently addressed is dropped past this bound.
 *
 * Sized so an ordinary working set — a session's channel and the agents on it —
 * never evicts, while a long day of browsing cannot grow the map without end.
 */
export const COMPOSER_RETAINED_ADDRESS_CAP = 12;

/**
 * Lines the directive line grows to before it scrolls.
 *
 * The composer is one line that grows to a cap. The cap is what keeps it from eating
 * the ledger it is addressed within: past this the input scrolls inside its own box and
 * the session above it keeps its room.
 */
export const COMPOSER_DIRECTIVE_LINE_MAX_ROWS = 8;

/**
 * Pages of the workflow definition enumeration one composer read walks.
 *
 * `workflow.definitionList` is cursor paged, and the accelerator has to see every
 * page: a name matched against the first one alone refuses a definition the daemon
 * does carry. The walk is still bounded, because a daemon that kept handing back a
 * cursor would otherwise loop on a person's keystroke — so the read stops here and
 * reports itself incomplete, which is a partial list a surface may say is partial
 * rather than a search it may call finished.
 *
 * Sized well past what a session's own definitions plus the project and shared scopes
 * reach at the wire's default page size, so the cap bounds a pathological answer and
 * never an ordinary one.
 */
export const COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP = 20;
