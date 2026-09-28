// The agent card's door, for the sibling that mounts it.
//
// A SUB-MODULE DOOR AND NOT A FAMILY ONE. The card and its parts are one module
// directory, and this package's structure rule gives such a directory a door exactly
// when a sibling takes from it, which `agent-console/AgentBindingColumn.tsx` does.
//
// WHAT STAYS AT THE FAMILY ROOT. `AxisCombobox.tsx`, `driver-catalog.ts` and
// `dependent-axis-chain.ts` are shared by more than one surface, so they belong to the
// family rather than to any one of its directories.
//
// WHAT IS PUBLISHED IS WHAT THE SIBLING TAKES, and nothing for symmetry. The column
// mounts the card and states the tool-grant ceiling above the roster, and reads
// nothing else here: the card's parts are its own composition, and the grant
// projection is read by the card itself.
//
// WHY THE CEILING IS PUBLISHED FROM HERE AND RENDERED A LEVEL UP. It is the node-wide
// half of the tool-governance rule the three modules in this directory hold — the
// projection, the line, and the echo's row — so it belongs beside them; but it is true
// of every agent in the roster rather than of any one of them, so the column renders
// it once above the cards rather than the card rendering it per agent.

export { AgentCard } from "./AgentCard.js";
export { ToolGrantCeiling } from "./ToolGrantCeiling.js";
