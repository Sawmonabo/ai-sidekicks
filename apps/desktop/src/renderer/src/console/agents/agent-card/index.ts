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
// mounts the card and states the tool-grant ceiling above the roster, and reads
// nothing else here: the card's parts are its own composition, and the grant
// projection is read by the card itself. A door line for any of them would be an
// export no module outside this directory names, which the barrel census fails.
//
// WHY THE CEILING IS PUBLISHED FROM HERE AND RENDERED A LEVEL UP. It is the node-wide
// half of the tool-governance rule the three modules in this directory hold — the
// projection, the line, and the echo's row — so it belongs beside them; but it is true
// of every agent in the roster rather than of any one of them, so the column renders
// it once above the cards rather than the card rendering it per agent.

export { AgentCard } from "./AgentCard.js";
export { ToolGrantCeiling } from "./ToolGrantCeiling.js";
