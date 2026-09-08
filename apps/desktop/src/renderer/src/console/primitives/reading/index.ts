// The reading sub-module door: what a SIBLING inside `primitives/` takes from here.
//
// The incomplete-reading vocabulary, its notice shape, and the two components that
// put one on screen. A reading is a fact about a READ — how much of it landed and
// why the rest did not — which is why it sits beside the absence vocabulary rather
// than inside it.
//
// ONE EDGE EARNED THIS DOOR, and it runs the other way from the one a reader
// expects: `announce/reading-announcement.ts` folds a `ReadingState` into the
// sentence it speaks, so the announcer reads the vocabulary and this directory reads
// nothing of the announcer's. The set below is exactly what that module takes.
//
// AND THE SHEET ENTERS HERE, for the reason the rule keys on: a directory carrying a
// door owns its own rules, whatever its depth.

import "./partial-read.css";

export type { PartialReadNotice, ReadingState } from "./partial-read.js";
export { partialReadNotices } from "./partial-read.js";
