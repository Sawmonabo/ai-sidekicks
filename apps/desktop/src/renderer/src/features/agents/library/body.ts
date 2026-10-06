// The agent library's body, the root of the chunk it arrives in. Loader-backed, so the page,
// its rows and their sheets stay off the initial import graph.

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
