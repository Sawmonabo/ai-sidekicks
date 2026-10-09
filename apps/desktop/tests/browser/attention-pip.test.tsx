// The rail's attention pip drawn in Chromium: the amber wash inside an amber outline, its count in
// amber text at the body's weight. Each color is read off a probe painted with the token itself,
// so the test follows the theme's values rather than restating them.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  NavigationRail,
  RAIL_ENTRY_TEMPLATES,
} from "#renderer/layout/NavigationRail/NavigationRail.js";

afterEach(() => {
  cleanup();
});

/** The color `token` resolves to, as the browser reports a computed color. */
function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(--meridian-${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

it("draws the pip as the amber wash in an amber outline, its count in amber text", () => {
  installMeridianTokens(document);
  const { container } = render(
    <NavigationRail
      entries={[{ destination: "sessions", ...RAIL_ENTRY_TEMPLATES.sessions }]}
      settingsEntry={{ destination: "settings", ...RAIL_ENTRY_TEMPLATES.settings }}
      current={undefined}
      onSelect={() => undefined}
      chords={{}}
      sessionsList={{ isExpanded: false, controlsId: "sessions", onToggle: () => undefined }}
      attention={{
        isExpanded: false,
        controlsId: "notifications",
        onToggle: () => undefined,
        count: 5,
      }}
      onCycleColorScheme={() => undefined}
      isUpdateStaged={false}
    />,
  );
  const pip = container.querySelector(".meridian-rail__pip");
  const figure = pip?.firstElementChild;
  if (pip === null || figure === null || figure === undefined) {
    throw new Error("the rail drew no attention pip with a count");
  }

  const pipStyle = getComputedStyle(pip);
  expect(pipStyle.backgroundColor).toBe(tokenColor("amber-ground"));
  expect(pipStyle.borderTopStyle).toBe("solid");
  expect(pipStyle.borderTopColor).toBe(tokenColor("amber-mark"));
  const figureStyle = getComputedStyle(figure);
  expect(figure.textContent).toBe("5");
  expect(figureStyle.color).toBe(tokenColor("amber-text"));
  expect(figureStyle.fontWeight).toBe("400");
});
