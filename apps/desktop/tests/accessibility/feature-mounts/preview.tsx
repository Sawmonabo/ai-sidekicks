// The preview pane, mounted once for the accessibility tier, with the body the pane registry
// resolves so the tier renders what the pane layout would mount.

import type { FunctionComponent } from "react";

import { registerPreviewPanes } from "@renderer/features/preview/contributions/panes.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "../../helpers/fixture/bridge.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";
import { type MountedView, paneTrailName, requireLabeledRegion } from "./mount-queries.js";
import { paneContext } from "../../helpers/pane-context.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";

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
        {...paneContext(
          { kind: "browser" },
          { paneId: "pane-preview", bridge, sessionStore: undefined },
        )}
      />
    </FixtureBridgeProvider>,
  );
  return {
    element: requireLabeledRegion(container, paneTrailName(undefined, "Preview")),
    bridge,
  };
}
