// The composer's claim on the composer registry. It is a call, not a module side effect, so
// importing the file (a test, a graph walk) never fills the registry and collides with the real
// owner; the composition calls it.

import { createElement } from "react";

import { registerComposer } from "@renderer/registries/composer/composer-registry.js";
import { MessageComposer } from "../Composer.js";

/** Fill the composer registry. The owner string appears in duplicate-claim errors. */
export function registerComposerView(): void {
  registerComposer("composer", (props) => createElement(MessageComposer, props));
}
