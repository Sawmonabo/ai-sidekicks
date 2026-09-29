// The agent definitions page's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, so the page, its registry view, its rows and its sheet are not
// on the initial import graph. The page is a settings section: a person navigates to
// settings and then chooses a section, which is two acts after the first paint. The
// sheet is named here and nowhere else, so it loads with the page and no other surface.

import "./agent-library.css";

import { createElement } from "react";

import { AgentDefinitionsFrame } from "./AgentLibrary.js";

/**
 * The saved-definition registry page's frame, as the settings board loads it.
 *
 * @consumedBy the agent library screen, once its registration mounts this chunk
 */
export function Body(): React.ReactNode {
  return createElement(AgentDefinitionsFrame);
}
