// The composer's claim on the composer registry.
//
// WHY A CALL AND NOT A MODULE SIDE EFFECT. `registerComposer` at this module's top
// level would fill the registry for anyone who imported the file for any reason — a test
// reaching for the component, a tool walking the graph — and an owner-scoped entry
// filled by accident is one the real owner then collides with. The composition calls
// this, so the composition is what registers.

import { createElement } from "react";

import { registerComposer } from "@renderer/console/seats/index.js";
import { MessageComposer } from "../Composer.js";

/**
 * Fill the composer registry with the composer.
 *
 * The owner string is what a duplicate-claim refusal names, so it reads as the
 * feature rather than as a task id: a person who meets it meets it in an error message.
 */
export function registerComposerFamily(): void {
  registerComposer("composer", (props) => createElement(MessageComposer, props));
}
