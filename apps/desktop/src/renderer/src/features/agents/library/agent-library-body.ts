// The agent library's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, so the page, its registry view, its rows and its sheet are not
// on the initial import graph: nothing paints the library before a person opens it. The
// sheet is named here and nowhere else, so it loads with the page and no other surface.

import "./agent-library.css";

import { createElement } from "react";

import { AgentDefinitionsFrame } from "./AgentLibrary.js";

/**
 * The agent library's frame, as this chunk hands it to the screen that mounts it.
 *
 * @consumedBy the agent library screen, once its registration mounts this chunk
 */
export function Body(): React.ReactNode {
  return createElement(AgentDefinitionsFrame);
}
