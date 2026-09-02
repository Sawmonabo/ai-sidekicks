// The composer family's door, and the one call that fills the composer seat.
//
// WHY A CALL AND NOT A MODULE SIDE EFFECT
//
// `registerComposerSeat` at this module's top level would fill the seat for anyone
// who imported the file for any reason — a test reaching for the component, a tool
// walking the graph — and an owner-scoped seat filled by an accident is a seat the
// real owner then collides with. `console/families.ts` composes the console, so the
// composition is what registers.
//
// WHY THE SIGNATURE TAKES NO REGISTRY
//
// The other families claim a SURFACE SLOT and are handed the registry to claim it
// in. This family claims none: the composer is a seat under the deck rather than a
// route destination, and its panes are claimed through `console/panes/index.ts`,
// which is handed its own registry. A parameter this function did not read would
// only make a reader look for the claim that is not there.

import { createElement } from "react";

import {
  registerComposerSeat,
  registerComposerSidebarSections,
} from "../console/workspace/index.js";
import { MessageComposer } from "./MessageComposer.js";

import "./composer.css";

/**
 * Fill the composer seat.
 *
 * The owner string is what a duplicate-claim refusal names, so it reads as the
 * family rather than as a task id: the console's runtime strings carry no
 * governance ids, and a person who meets this one meets it in an error message.
 */
export function registerComposerFamily(): void {
  registerComposerSeat("composer", (props) => createElement(MessageComposer, props));
  // The sidebar frame is this family's too, and so is exactly one of the six
  // sections it renders. The other five are the collaboration and repos
  // families', registered from their own composition for the same reason.
  registerComposerSidebarSections();
}
