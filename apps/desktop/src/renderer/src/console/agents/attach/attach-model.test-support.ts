// The definition and the pre-named form both attach-model suites are driven with.
//
// The form's two subjects — the request it composes and the chain its fields form —
// are two suites, and these are what they share: a stored definition row to attach
// FROM, and a form that already carries the name both arms require, so no case has
// to spend three lines reaching its own subject.
//
// The `SESSION_ID` is here for the same reason it is a constant at all: a request
// composed against one session and asserted against another passes a shape check and
// says nothing, and two files inventing their own ids is how that happens.

import { AttachSidekickForm } from "./attach-model.js";

/** The session every composed request is bound to. */
export const SESSION_ID = "session-9";

/** A stored definition row, as the picker projects one. */
export const DEFINITION = {
  definitionId: "definition-scout",
  name: "Scout",
  driverName: "claude",
  modelId: "claude-sonnet",
  effort: "high",
} as const;

/** A form that already carries the agent name both arms require. */
export function namedForm(name = "Scout"): AttachSidekickForm {
  const form = new AttachSidekickForm();
  form.setName(name);
  return form;
}
