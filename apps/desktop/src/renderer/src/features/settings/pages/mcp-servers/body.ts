// The MCP servers settings page's body, and the root of the chunk it arrives in.
//
// Loader-backed so the page and its sheet stay off the initial import graph. The body draws the
// page frame around the mount, which binds this window's bridge.

import { createElement } from "react";

import { McpServersMount } from "./McpServersMount.js";

/** The MCP servers page, as the settings page registry loads it. */
export function Body(): React.ReactNode {
  return createElement(
    "div",
    { className: "meridian-settings-page" },
    createElement(McpServersMount),
  );
}
