// The identifiers the runs scenario's two halves both name.
//
// Its own module because the beats and the scripted replies describe the SAME three
// queue rows and the same run, and they now live in two files: an id declared in
// either one would be a value the other half could only match by copying it, which is
// exactly how a fixture comes to script a reply about a row no beat ever mentions.

// UUID v7 values whose leading bytes are this scenario's own start instant, so a reader
// scanning a rendered id can still tell one fixture apart from another.
export const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";
export const PARTICIPANT_YOU = "019b7a22-2200-79a4-8110-cca0117a0410";
export const AGENT_IMPLEMENTER = "019b7a22-2200-7a6e-8110-d1a4c1150401";
export const RUN_ID = "019b7a22-2200-740e-8110-d1a4c1150411";

// `QueueItemId` is a branded UUID: a readable `queue-01` fails the registered parse,
// and the list reply being strict, that failure takes the WHOLE reply down.
export const QUEUE_ITEM_ADMITTED = "019b7a22-2200-7c11-8110-d1a4c1150421";
export const QUEUE_ITEM_WAITING = "019b7a22-2200-7c11-8120-d1a4c1150422";
export const QUEUE_ITEM_EXPIRING = "019b7a22-2200-7c11-8130-d1a4c1150423";

/** The turn boundary the accepted rollback lands the run on. */
export const REWIND_TARGET_POSITION = 4;
