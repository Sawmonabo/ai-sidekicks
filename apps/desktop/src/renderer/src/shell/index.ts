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
// WHY THE SIGNATURE TAKES ONE BOARD
//
// The other families claim a SURFACE SLOT and are handed the registry to claim it
// in. This family claims none: the composer is a seat under the deck rather than a
// route destination. What it does claim is a FOLD — the approval-flow event kinds,
// whose entities the approval card reads — so that board is what this function takes.
// A surface or pane registry it did not read would only make a reader look for the
// claim that is not there.

import { createElement } from "react";

import { registerApprovalFlowProjectors } from "@renderer/store/session-events/approval-flow-projection.js";
import { registerComposerSeat } from "../console/seats/index.js";
import type { ConsoleEntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { MessageComposer } from "@renderer/features/composer/Composer.js";

import "@renderer/features/composer/Composer.css";

/**
 * Fill the composer seat.
 *
 * The owner string is what a duplicate-claim refusal names, so it reads as the
 * family rather than as a task id: the console's runtime strings carry no
 * governance ids, and a person who meets this one meets it in an error message.
 */
export function registerComposerFamily(projectorRegistry: ConsoleEntityProjectorRegistry): void {
  registerComposerSeat("composer", (props) => createElement(MessageComposer, props));
  // The approval-flow fold, claimed on the board this function was HANDED rather
  // than on the module-scope singleton, so a test and an auxiliary window compose
  // their own. Without it the `approval` partition has no producer at all and the
  // pane can read no entity for a row — which is where `askId` was landing, since
  // the projection reply registers no member for it.
  registerApprovalFlowProjectors(projectorRegistry);
}
