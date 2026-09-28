// The browser settings page names itself for a reader walking the settings surface.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrowserSettingsPage } from "./BrowserSettingsPage.js";
import { BrowserPolicySettings, type BrowserPolicySettingsProps } from "./PolicySettings.js";

const READ_SWITCHES: BrowserPolicySettingsProps["positions"] = {
  "file-boundary": false,
  "page-tools": true,
};

function renderPage(): HTMLElement {
  const { container } = render(
    <BrowserSettingsPage>
      <BrowserPolicySettings positions={READ_SWITCHES} onToggle={() => undefined} />
    </BrowserSettingsPage>,
  );
  const page = container.querySelector("section");
  if (!(page instanceof HTMLElement)) {
    throw new Error("BrowserSettingsPage rendered no page");
  }
  return page;
}

describe("browser settings page — naming", () => {
  it("names itself for a reader walking the settings surface", () => {
    const page = renderPage();
    const titleId = page.getAttribute("aria-labelledby");
    expect(page.querySelector(`#${String(titleId)}`)?.textContent).toBe("Browser");
  });
});
