import { type PaneRegistry } from "@renderer/console/seats/index.js";
import { TRANSCRIPT_OWNER } from "./screens.js";

/**
 * Claim the pane layout's `transcript` kind.
 *
 * The descriptor says WHO owns the kind and WHAT mounts for it, and nothing else.
 *
 * The body is mounted with no close handler: closing is the pane layout's act, it reaches the
 * chrome through the host context the pane layout provides, and a control whose act nobody can
 * perform is left out rather than drawn disabled.
 */
export function registerTranscriptPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "transcript",
    owner: TRANSCRIPT_OWNER,
    // LOADER-BACKED, like every other kind on this board: the pane is reached by opening
    // a session, which is an act, and `transcript-pane-body.ts` carries the rest of the
    // reasoning. The specifier is written at the registration so the chunk boundary is
    // visible where the claim is made, and the pane layout's own reserved pane chrome stands in
    // the body's place while the module is in flight.
    body: () => import("./transcript-pane-body.js"),
  });
}
