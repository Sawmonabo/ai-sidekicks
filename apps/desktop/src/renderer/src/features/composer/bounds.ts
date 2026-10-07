// The composer feature's named bounds, kept together so another module does not copy one.

/**
 * Sent messages the draft line's history recall walks. Deep enough to reach the message before
 * last after a correction and a retry; past it the transcript is the archive.
 */
export const COMPOSER_HISTORY_RECALL_CAP = 20;

/**
 * Composer addresses whose recall history one window retains. History is per address so
 * re-addressing never walks another target's messages into this line; the least recently
 * addressed is dropped past this bound so the map cannot grow all day. Sized so a session and its
 * agents never evict.
 */
export const COMPOSER_RETAINED_ADDRESS_CAP = 12;

/**
 * The most lines the draft line grows to before it scrolls; `Composer.css` caps it lower when a
 * third of the conversation's visible height is shorter.
 */
export const COMPOSER_DRAFT_MAX_ROWS = 8;

/**
 * Pages of the workflow definition enumeration one composer read walks. `workflow.definitionList`
 * is cursor paged and every page must be seen, but a daemon that kept returning a cursor would
 * loop on a keystroke, so the read stops here and reports itself incomplete. Sized well past what
 * a session's definitions reach at the default page size: it bounds a pathological answer only.
 */
export const COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP = 20;
