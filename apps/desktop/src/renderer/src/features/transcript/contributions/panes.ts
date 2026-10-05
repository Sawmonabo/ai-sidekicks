import { type PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { TRANSCRIPT_OWNER } from "./screens.js";

/**
 * Claim the pane layout's `transcript` kind. The body mounts with no close handler: closing is
 * the pane layout's act and reaches the chrome through the host context, and a control nobody
 * can perform is left out rather than drawn disabled.
 */
export function registerTranscriptPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "transcript",
    owner: TRANSCRIPT_OWNER,
    // Loader-backed: the pane is reached by opening a session, so its chunk loads on demand.
    // The specifier sits here so the chunk boundary shows where the claim is made; the pane
    // layout's reserved chrome stands in while the module is in flight.
    body: () => import("./transcript-pane-body.js"),
  });
}
