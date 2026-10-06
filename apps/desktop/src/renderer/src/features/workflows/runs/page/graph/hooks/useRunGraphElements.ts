import { useMemo } from "react";
import type { Edge } from "@xyflow/react";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/run";
import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import {
  NO_HANDLES,
  nodeHandleIds,
  runGraphNodeBox,
  runGraphNodeCenter,
  toRunGraphFlowEdges,
  toRunGraphFlowNodes,
  type RunGraphFlowNode,
} from "../elements.js";
import { placeRunGraphNodes, type CanvasPoint } from "../layout.js";
import { flowingEdgeIds, liveNodeId, runGraphNodeViews, widestCountFigure } from "../model.js";

/**
 * What the canvas hands the library, and where the live step stands.
 *
 * The arrays are mutable because the library's props are; nothing here mutates them.
 */
export interface RunGraphElements {
  readonly nodes: RunGraphFlowNode[];
  readonly edges: Edge[];
  /** The live node's center; absent once nothing in the run is live. */
  readonly liveCenter: CanvasPoint | undefined;
}

/**
 * The run's nodes and edges, each rebuilt only when what it reads moves: handles with the
 * document, places with it and the widest count the run reports, which every box keeps room for;
 * edges with the item counts and the steps they flow with; states with the steps and counts; the
 * mark with the selection. The library re-enters its store whenever an array's identity moves.
 */
export function useRunGraphElements(
  document: WorkflowDocument,
  steps: readonly WorkflowStep[],
  edgeItemCounts: readonly WorkflowEdgeItemCount[],
  selectedNodeId: string | undefined,
  nowMs: number,
): RunGraphElements {
  const handles = useMemo(() => nodeHandleIds(document), [document]);
  const edges = useMemo(
    () => toRunGraphFlowEdges(document, edgeItemCounts, flowingEdgeIds(document, steps)),
    [document, edgeItemCounts, steps],
  );
  const views = useMemo(
    () => runGraphNodeViews(document, steps, edgeItemCounts, nowMs),
    [document, steps, edgeItemCounts, nowMs],
  );
  // A string, so a step update that leaves the widest count as it was keeps every place.
  const countFigure = widestCountFigure(views);
  const positions = useMemo(
    () =>
      placeRunGraphNodes(document, (node) =>
        runGraphNodeBox(node, handles.get(node.id) ?? NO_HANDLES, countFigure, false),
      ),
    [document, handles, countFigure],
  );
  const nodes = useMemo(
    () => toRunGraphFlowNodes(views, handles, positions, selectedNodeId, countFigure),
    [views, handles, positions, selectedNodeId, countFigure],
  );
  const liveCenter = useMemo(() => {
    const liveId = liveNodeId(steps);
    const liveNode = nodes.find((node) => node.id === liveId);
    return liveNode === undefined ? undefined : runGraphNodeCenter(liveNode);
  }, [nodes, steps]);
  return { nodes, edges, liveCenter };
}
