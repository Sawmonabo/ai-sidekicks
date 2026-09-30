// The preview pane, mounted once for the screenshot and accessibility tiers, with the body the
// pane registry resolves so a tier renders what the pane layout would mount.

import type { FunctionComponent } from "react";

import { registerPreviewPanes } from "@renderer/features/preview/contributions/panes.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "../fixture-bridge.js";
import { FixtureBridgeProvider } from "../app-frame-fixtures.js";
import { renderSettled } from "../app-harness.js";
import { type MountedView, paneTrailName, requireLabeledRegion } from "./mount-queries.js";
import { paneBinding, resolvedPaneBody } from "./pane-body-resolution.js";

/** The preview pane, mounted and settled. */
export async function mountPreviewPane(): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("preview-pane") });
  const { bridge } = fixture;
  const PreviewPaneBody: FunctionComponent<PaneContext> = await resolvedPaneBody(
    "browser",
    registerPreviewPanes,
  );
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <PreviewPaneBody
        kind="browser"
        {...paneBinding({ paneId: "pane-preview", bridge, sessionStore: undefined })}
      />
    </FixtureBridgeProvider>,
  );
  return {
    element: requireLabeledRegion(container, paneTrailName(undefined, "Preview")),
    bridge,
  };
}
