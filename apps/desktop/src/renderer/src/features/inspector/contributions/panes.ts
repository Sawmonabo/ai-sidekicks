// The inspector pane's registration: one kind claimed, one body behind it.
//
// The feature's `index.ts` publishes the registrar and `app/registrations.ts` calls it. The
// owner string is the kind's owner, not the feature's, since the registry refuses a second
// owner on one kind and the refusal should say which body is already there. The stylesheet is
// not imported here: the pane is loader-backed, so the body module owns it.

import { type PaneRegistry } from "#renderer/registries/panes/registry.js";

/** Claim the `inspector` kind, with its body loaded on demand. */
export function registerInspectorPane(registry: PaneRegistry): void {
  registry.register({
    kind: "inspector",
    owner: "inspector-pane",
    // A loader, not a `render`: the body, readers and sheets ride a separate chunk.
    body: () => import("./pane-body.js"),
  });
}
