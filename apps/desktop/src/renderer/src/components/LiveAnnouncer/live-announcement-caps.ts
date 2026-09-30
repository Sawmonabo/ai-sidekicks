// The live announcer's queue depth and its hold window, per politeness lane.
//
// One mechanism in two numbers: a full lane drains in the queue cap times the hold, so
// moving either moves how long the last announcement in a burst waits to be spoken.

/**
 * Announcements held in one politeness lane while an earlier one is standing. Past it the oldest
 * is dropped, since the newest fact is the one still true. Per lane, so a polite burst cannot
 * shed a refusal.
 */
export const LIVE_ANNOUNCEMENT_QUEUE_CAP = 8;

/**
 * How long one announcement stays in its region before it is cleared and the next is published.
 * Long enough for assistive technology to observe the text (a region reverted within a frame
 * announces nothing); cleared afterwards so an identical repeat is a real change.
 */
export const LIVE_ANNOUNCEMENT_HOLD_MS = 500;
