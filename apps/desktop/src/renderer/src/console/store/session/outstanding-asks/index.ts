// What the store's own modules take from the outstanding-ask journal.
//
// A SUB-MODULE DOOR AND NOT A FAMILY DOOR: it publishes to `store/` and to nowhere
// else, and what it publishes is exactly what a sibling takes — the journal three
// folds advance, and the reading `session-store.ts` answers with. The vocabulary
// beside it is deliberately absent: the journal is its only reader, so a line for it
// here would publish a name no sibling takes.

export { OutstandingAskJournal } from "./outstanding-ask-journal.js";
export type { OutstandingAskLedger } from "./outstanding-ask-journal.js";
