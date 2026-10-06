// The search above the page list: which pages and controls a term finds, and in what order.

import { describe, expect, it } from "vitest";

import { SETTINGS_PAGE_LABELS } from "./pages/labels.js";
import type { SettingsPageDescriptor } from "./pages/registry.js";
import { findSettings } from "./search.js";
import type { SettingsControl } from "./types.js";
import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

function pageFor(
  pageId: SettingsPageId,
  keywords: readonly string[],
  controls: readonly SettingsControl[],
): SettingsPageDescriptor {
  return {
    pageId,
    label: SETTINGS_PAGE_LABELS[pageId],
    keywords,
    note: "",
    controls,
    render: () => null,
  };
}

// In page order. Every word below was chosen so it appears, as a subsequence, only where the
// case says it does.
const PAGES = [
  pageFor(
    "general",
    ["about"],
    [
      { id: "proxy", label: "Proxy", hint: "Used for every port" },
      { id: "open-ports", label: "Open ports", heading: "Network" },
    ],
  ),
  pageFor(
    "runtime",
    [],
    [
      { id: "listener", label: "Listener address", heading: "Ports and listeners" },
      { id: "port-number", label: "Port number" },
    ],
  ),
];

/** Each hit as the page and control it opens and the place it reads. */
function described(query: string): readonly string[] {
  return findSettings(PAGES, query).map(
    (hit) => `${hit.pageId}/${hit.controlId ?? "(page)"} · ${hit.label} · ${hit.place}`,
  );
}

describe("settings search", () => {
  it("keeps only what holds every typed word, in its label, heading or hint", () => {
    // Both words in one label.
    expect(described("open ports")).toStrictEqual([
      "general/open-ports · Open ports · General › Network",
    ]);
    // One word in the label and one in the heading still holds every word.
    expect(described("open network")).toStrictEqual([
      "general/open-ports · Open ports · General › Network",
    ]);
    // "number" appears only under one control and "network" only under another: no control holds
    // both, so nothing is found.
    expect(described("number network")).toStrictEqual([]);
    // A word nothing holds, and a blank box, find nothing.
    expect(described("zzzz")).toStrictEqual([]);
    expect(described("   ")).toStrictEqual([]);
    // A page is found by a word it declares, and opens the page itself.
    expect(described("about")).toStrictEqual(["general/(page) · General · Settings"]);
  });

  it("ranks a label hit over a heading hit over a hint hit, and equal ranks in page order", () => {
    expect(described("port")).toStrictEqual([
      "general/open-ports · Open ports · General › Network",
      "runtime/port-number · Port number · Runtime",
      "runtime/listener · Listener address · Runtime › Ports and listeners",
      "general/proxy · Proxy · General",
    ]);
  });
});
