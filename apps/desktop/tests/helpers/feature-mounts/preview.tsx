// The preview pane, mounted once for the screenshot and accessibility tiers.
//
// The body comes out of a pane registry the preview feature registers into, so a tier
// renders the body the pane layout would mount, with the stylesheets it brings.

import type { FunctionComponent } from "react";

import { registerPreviewPanes } from "@renderer/features/preview/contributions/panes.js";
import { type PaneContext } from "@renderer/console/seats/index.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "../fixture-bridge.js";
import { renderSettled } from "../app-harness.js";
import { type MountedView, paneTrailName, requireLabeledRegion } from "./mount-queries.js";
import { paneBinding, resolvedPaneBody } from "./pane-body-resolution.js";

/** The preview pane, mounted and settled. */
export async function mountPreviewPane(): Promise<MountedView> {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario("preview-surface") });
  const PreviewPaneBody: FunctionComponent<PaneContext> = await resolvedPaneBody(
    "browser",
    registerPreviewPanes,
  );
  const { container } = await renderSettled(
    <PreviewPaneBody
      kind="browser"
      {...paneBinding({ paneId: "pane-preview-surface", bridge, sessionStore: undefined })}
    />,
  );
  return {
    element: requireLabeledRegion(container, paneTrailName(undefined, "Browser")),
    bridge,
  };
}
