// Bounds on what the persistence layer keeps, and on the live drafts that never reach it.

/**
 * Sessions whose UI state the persistence layer keeps. Past this the least recently touched
 * partition is trimmed, so a long-lived install does not grow an unbounded IndexedDB.
 */
export const PERSISTENCE_SESSION_PARTITION_CAP = 40;

/**
 * Bytes one persisted UI-state record may occupy: its partition, key, class and serialized
 * value together. A layout snapshot or an expansion set is kilobytes, so the cap is a second
 * line of defense behind the value-class enumeration, not a performance knob. The address
 * counts because it is stored too, and an index holds a second copy of the key.
 */
export const PERSISTENCE_RECORD_BYTE_CAP: number = 64 * 1024;

/**
 * Fraction of the storage quota at which the gauge reports pressure. Reported, never acted on
 * silently: the operator is told rather than losing their layout behind their back.
 */
export const PERSISTENCE_QUOTA_PRESSURE_RATIO = 0.8;

/**
 * Live composer drafts one window holds before the oldest is evicted.
 *
 * More composers than a person has open, and still bounded: drafts are held in memory only, so
 * the ceiling keeps abandoned text from growing without limit. The frame supplies it to
 * `DraftStore` because that module imports nothing.
 */
export const MAXIMUM_LIVE_DRAFT_COUNT = 64;
