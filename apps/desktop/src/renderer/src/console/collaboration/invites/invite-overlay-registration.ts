// The one call that fills the window overlay seat with the deep-link invite lifecycle.
//
// A CALL AND NOT A MODULE SIDE EFFECT, for the reason `shell/index.ts` gives about the
// composer seat: a registration at a module's top level fills the seat for anybody who
// imports the file for any reason — a suite reaching for the component, a tool walking
// the graph — and an owner-scoped seat filled by an accident is a seat the real owner
// then collides with. `console/collaboration-family.ts` composes this family, so the
// composition is what registers.
//
// A `.ts` MODULE THAT BUILDS AN ELEMENT, the shape `sections.ts` and
// `seats/surface/absorbed-surfaces.ts` already take: it owns the CLAIM — which seat this family
// fills and what mounts in it — rather than a view, so it takes `createElement` instead
// of JSX.

import { createElement } from "react";

import { registerWindowOverlaySeat } from "../../seats/index.js";
import { InviteLifecycleOverlay } from "./InviteLifecycleOverlay.js";

/**
 * The owner string a duplicate claim on the seat names.
 *
 * It reads as the family rather than as a task id: the console's runtime strings carry
 * no governance ids, and a person who meets this one meets it in an error message.
 */
const INVITE_OVERLAY_OWNER = "collaboration-invite-lifecycle";

/** Fill the window overlay seat with the deep-link invite lifecycle. */
export function registerInviteLifecycleOverlay(): void {
  registerWindowOverlaySeat(INVITE_OVERLAY_OWNER, (props) =>
    createElement(InviteLifecycleOverlay, props),
  );
}
