// What one session store holds before it stops growing, and how wide a hole it repairs. The
// repairable gap sits above what the pre-initialization buffer can shed, or ordinary overflow
// would report the stream diverged over events the buffer kept.

/**
 * Wire events one session store holds while it waits for its first read, ordinarily a handful
 * over the milliseconds before the read lands. Past this bound the read is not coming: the
 * oldest is dropped and the loss is recorded (re-derived as a sequence gap once a base state
 * arrives) rather than buffering an entire stream.
 */
export const PRE_INITIALIZATION_BUFFER_CAP = 512;

/**
 * Sequences a session store will carry as a repairable hole before it calls the stream diverged.
 *
 * A hole is a range, so width costs nothing; the bound is about repairability. Past it the
 * arithmetic describes a different stream: admitting the event would move the cursor to a
 * position an authoritative read may never answer at, and every later repair would be refused
 * as a rewind. So the event is refused and a base-state read is the repair. It bounds accumulated
 * loss, which also bounds the range list.
 */
export const MAX_REPAIRABLE_SEQUENCE_GAP = 1024;
