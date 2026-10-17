// The events a person's next act raises anywhere in a window: a press, a key, a wheel turn or a
// touch drag, which scrolls a touch screen with no wheel. What waits on the person's next act
// (a line raised for one moment, a landing still looking for its control) ends on the first.

/** The document events that mark a person's next act, heard in the capture phase. */
export const NEXT_ACT_EVENTS = ["pointerdown", "keydown", "wheel", "touchmove"] as const;
