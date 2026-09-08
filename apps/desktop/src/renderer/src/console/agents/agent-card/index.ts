// The agent card's door, for the sibling that mounts it.
//
// A SUB-MODULE DOOR AND NOT A FAMILY ONE. The card and its seven parts were fifteen
// files deep in the family root beside the attach form's shared pieces, which made
// "which of these is the card" a question a reader answered by opening files. They
// are one module directory now, on the shape `attach/`, `provider-switch/`,
// `definitions/` and `run-console/` already have — and this package's structure rule
// gives such a directory a door exactly when a sibling takes from it, which
// `agent-console/AgentBindingColumn.tsx` does.
//
// WHAT STAYED AT THE FAMILY ROOT, and why it is not an omission. `AxisCombobox.tsx`,
// `driver-catalog.ts` and `dependent-axis-chain.ts` are taken by the attach form and
// the provider switch alike, so they belong to the family rather than to any one of
// its directories; moving them in here would have made two siblings reach through
// this door for something the card does not own.
//
// WHAT IS PUBLISHED IS WHAT THE SIBLING TAKES, and nothing for symmetry. The column
// mounts the card and reads nothing else here: the seven parts are the card's own
// composition, and the grant projection is read by the card itself. A door line for
// either would be an export no module outside this directory names, which the barrel
// census fails.

export { AgentCard } from "./AgentCard.js";
