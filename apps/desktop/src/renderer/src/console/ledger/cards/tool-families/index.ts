// The tool sub-family door: the shell that draws a treatment, and the slot it fills.
//
// A DOOR HERE BECAUSE THIS DIRECTORY HAS READERS OTHER THAN ITSELF — the family's one
// criterion, stated in `ledger/cards/index.ts`: the tool card mounts the badge and
// reads the declaration, and the fixture shell rows hand it the slot.
//
// AND IT PUBLISHES EXACTLY WHAT THOSE TWO TAKE. The vocabulary tuple, the three
// payload member names, and the reading's own shape are read inside this directory
// and by its own suites, which reach the declaring module directly — a door line with
// no production reader is a dead export the barrel census fails, so this door is
// never widened for symmetry.
//
// AND THE SHEET IS IMPORTED HERE, because the door that owns a directory is the door
// that imports its sheet and this one publishes the component that draws every rule
// in it.

// The sheet this directory owns, imported by its own door.
import "./tool-families.css";

export { ToolSubFamilyBadge } from "./ToolSubFamilyBadge.js";

export {
  TOOL_SUB_FAMILY_SLOT,
  declaredToolSubFamily,
  type ToolSubFamilyRenderer,
} from "./tool-sub-families.js";
