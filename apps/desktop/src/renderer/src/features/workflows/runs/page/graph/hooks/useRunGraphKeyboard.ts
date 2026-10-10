import { isHTMLElement } from "@floating-ui/utils/dom";
import { useCallback } from "react";

import { runGraphNodeCenter } from "../elements.js";
import type { LiveStepFollow } from "./useLiveStepFollow.js";
import type { RunGraphElements } from "./useRunGraphElements.js";

/** The keys that select the focused node, as a button's do. */
const SELECT_KEYS: readonly string[] = ["Enter", " "];

/** The canvas's key and focus handlers: node selection by key, and revealing a node reached. */
export interface RunGraphKeyboard {
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  readonly onFocus: (event: React.FocusEvent<HTMLDivElement>) => void;
}

/**
 * Stops the follow on any key on the canvas, selects a node on Enter or Space, and brings a node
 * reached by keyboard into view, stopping the follow. Tab moves through the nodes in the browser's
 * own order; an edge's count takes no Tab stop of its own.
 */
export function useRunGraphKeyboard(
  nodes: RunGraphElements["nodes"],
  follow: Pick<LiveStepFollow, "stopFollowing" | "revealPoint">,
  onSelectNode: (nodeId: string) => void,
): RunGraphKeyboard {
  const { stopFollowing, revealPoint } = follow;

  // The library's own node keys are off along with its second live region, so Enter and Space
  // select here.
  const handleCanvasKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      stopFollowing();
      const nodeId = focusedNodeId(event.target);
      if (nodeId !== undefined && SELECT_KEYS.includes(event.key)) {
        event.preventDefault();
        onSelectNode(nodeId);
      }
    },
    [onSelectNode, stopFollowing],
  );

  // A node reached by keyboard, Tab in from outside the canvas included, is brought into view,
  // which the library does only with its own keys on, and the follow stops, so the next live step
  // never pulls the view off it; focus on the canvas's own controls or links leaves it running.
  const revealFocusedNode = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const nodeId = focusedNodeId(event.target);
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined || !event.target.matches(":focus-visible")) {
        return;
      }
      stopFollowing();
      revealPoint(runGraphNodeCenter(node));
    },
    [nodes, revealPoint, stopFollowing],
  );

  return { onKeyDown: handleCanvasKey, onFocus: revealFocusedNode };
}

/** The id of the node an event landed on, read from the library's node element. */
function focusedNodeId(target: EventTarget): string | undefined {
  if (!isHTMLElement(target) || !target.classList.contains("react-flow__node")) {
    return undefined;
  }
  return target.dataset["id"];
}
