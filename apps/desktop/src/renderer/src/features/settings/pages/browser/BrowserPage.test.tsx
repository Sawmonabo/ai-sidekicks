// The browser settings page names itself for a reader walking the settings screen.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrowserPage } from "./BrowserPage.js";
import {
  BrowserPolicySettings,
  type BrowserPolicySettingsProps,
} from "./components/BrowserPolicySettings.js";

const READ_SWITCHES: BrowserPolicySettingsProps["positions"] = {
  "file-boundary": false,
  "page-tools": true,
};

function renderPage(): HTMLElement {
  const { container } = render(
    <BrowserPage>
      <BrowserPolicySettings positions={READ_SWITCHES} onToggle={() => undefined} />
    </BrowserPage>,
  );
  const page = container.querySelector("section");
  if (!(page instanceof HTMLElement)) {
    throw new Error("BrowserSettingsPage rendered no page");
  }
  return page;
}

describe("browser settings page — naming", () => {
  it("names itself for a reader walking the settings screen", () => {
    const page = renderPage();
    const titleId = page.getAttribute("aria-labelledby");
    expect(page.querySelector(`#${String(titleId)}`)?.textContent).toBe("Browser");
  });
});
