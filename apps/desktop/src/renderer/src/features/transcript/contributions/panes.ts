import { type PaneRegistry } from "@renderer/console/seats/index.js";
import { TRANSCRIPT_OWNER } from "./screens.js";

/**
 * Claim the deck's `timeline` kind.
 *
 * The descriptor says WHO owns the kind and WHAT mounts for it, and nothing else.
 *
 * The body is mounted with no close handler: closing is the deck's act, it reaches the
 * chrome through the host context the deck provides, and a control whose act nobody can
 * perform is left out rather than drawn disabled.
 */
export function registerLedgerPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "timeline",
    owner: TRANSCRIPT_OWNER,
    // LOADER-BACKED, like every other kind on this board: the pane is reached by opening
    // a session, which is an act, and `transcript-pane-body.ts` carries the rest of the
    // reasoning. The specifier is written at the registration so the chunk boundary is
    // visible where the claim is made, and the deck's own reserved pane chrome stands in
    // the body's place while the module is in flight.
    body: () => import("./transcript-pane-body.js"),
  });
}
