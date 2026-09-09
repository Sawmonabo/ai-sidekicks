// What the persistence layer keeps, how large one record may be, and the one length
// bound its identifier grammar admits — beside the live drafts that never reach it.

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
 * and must not: acquiring anything there is the first move of persisting a draft.
 */
export const MAXIMUM_LIVE_DRAFT_COUNT = 64;
