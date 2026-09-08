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

import type { SidekickDefinitionSummary } from "../agent-wire.js";
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

/**
 * A definition that PINS a provider account, which {@link DEFINITION} does not.
 *
 * The two are both needed and neither can stand in for the other: what a dropped
 * account entry falls back to is the definition's own account on one and nothing at
 * all on the other, and those are the two answers the field's reset control has to
 * tell apart. Its own `definitionId`, so a case that swapped definitions is reading a
 * different row rather than the same one with a member added.
 */
export const DEFINITION_PINNING_ACCOUNT: SidekickDefinitionSummary = {
  ...DEFINITION,
  definitionId: "definition-pinned",
  providerAccountId: "acct-team",
};

/** A form that already carries the agent name both arms require. */
export function namedForm(name = "Scout"): AttachSidekickForm {
  const form = new AttachSidekickForm();
  form.setName(name);
  return form;
}
