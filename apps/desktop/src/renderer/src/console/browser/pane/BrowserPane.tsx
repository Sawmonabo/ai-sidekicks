// The deck's browser pane: ask the host for a view, then steer it.
//
// The pane host has two operations, and what they are for is settled — a view is
// created or adopted for this pane, and it is torn
// down again when the pane goes. Neither had a caller. A pane opened through the deck's
// registry started five subscriptions and dispatched every one of its acts against a
// `paneId` no view had ever been created for, and closing it disposed the renderer's
// reads while the main-process view went on painting over a rectangle nobody was
// reporting any more.
//
// SO THIS COMPONENT IS THE LIFECYCLE AND THE BODY IS A SIBLING. `view-binding.ts` owns
// the pair — attach on mount, tear down on unmount, and only where the attach was
// served — and it is opened through the console's subject-scoped resource holder, which
// mints during the render that first sees a `(bridge, paneId)`. That is the earliest
// moment anything can happen in this subtree: React runs a child's effects before its
// parent's, so a call made from an effect here would land AFTER the body's
// subscriptions, and a re-mount under a replaced bridge would re-attach against the
// wrong window. The holder also discards a reply for a subject the surface has left.
//
// AND THE BODY IS RENDERED FROM THE ANSWER RATHER THAN BESIDE IT. `BrowserPaneChrome`
// carries every read this pane makes, so mounting it is what opens them; a pane whose
// attach was refused renders `BrowserPaneViewAbsence` instead and opens none. That is a
// composition rather than a flag, because a flag would leave the subscriptions written
// where a later edit could start them anyway.
//
// THE `unasked` ARM RENDERS THE FULL BODY, AND THAT IS RULE 8 RATHER THAN AN EXCEPTION
// TO IT. A build whose browser namespace is registered nowhere refused before any
// request left this process — nobody asked, and every read the body makes refuses the
// same way and renders its own not-checked absence, which is exactly what that build is
// designed to show. Withholding the chrome there would tell a person the host had said
// no when the question was never put.

import { BrowserPaneChrome } from "./BrowserPaneChrome.js";
import { BrowserPaneViewAbsence } from "./BrowserPaneViewAbsence.js";
import { useBrowserPaneView } from "./view-binding.js";
import type { PaneContextOf } from "../../seats/index.js";

export function BrowserPane(context: PaneContextOf<"browser">): React.JSX.Element {
  const view = useBrowserPaneView(context.bridge, context.paneId);
  if (view.kind === "attaching" || view.kind === "refused") {
    return <BrowserPaneViewAbsence context={context} view={view} />;
  }
  return <BrowserPaneChrome {...context} />;
}
