// The wire shapes the console declares for itself, because no code package carries
// them.
//
// WHAT PUTS A MODULE HERE. `Spec-019`, `Spec-030` and `Spec-017` each register a
// namespace, and `docs/architecture/contracts/api-payload-contracts.md` fixes the
// spellings; `packages/contracts` and the client SDK carry none of them. A surface
// built against one of those wires would otherwise invent its shape inside a view
// family, which is the defect the growth slate exists to prevent — so the shape is
// declared once, at the wire's edge, and transcribed from the contracts document
// rather than re-derived from a spec's prose.
//
// WHAT DOES NOT BELONG HERE: a narrowing of a shape a package DOES register. Those
// answer a registered schema and live in `daemon/`, where the canonical bindings may
// be imported. The line is whether the corpus has a runtime shape to check against.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR — `growth-values/index.ts` states the
// rule. `bridge/index.ts` re-exports from the declaring module, never through here.

export type {
  AttentionItem,
  AttentionProjection,
  AttentionSeverity,
  AttentionTrigger,
} from "./attention-projection.js";

export type {
  AgentAttachReading,
  AgentAttachRequest,
  AgentConfigUpdateReading,
  AgentConfigUpdateRequest,
  AgentDetachRequest,
  AgentListRequest,
  AgentRosterReading,
  ChildRunLinkReadRequest,
  ChildRunLinkReading,
  PeerInvocationReading,
  PeerInvocationSetRequest,
} from "./agent-plane.js";

export type { SidekickDefinition, SidekickDefinitionDraft } from "./sidekick-definition.js";

// The definition BODY shapes, published to this family and no further. What a sibling
// takes is exactly this: the fixture's body table composes both read replies, and the
// growth signature table names all three. The four closed vocabularies stay OFF this
// door — the one module that reads them is `workflow-definition-file-form.ts` next
// door, which takes them from the module that declares them, and an inner-door line no
// sibling reaches is the dead export the structure gate reports.
export type {
  McpServerBindingRef,
  WorkflowDefinitionCreateBody,
  WorkflowDefinitionReadResult,
  WorkflowEntry,
  WorkflowPhaseDefinition,
  WorkflowVersionBody,
} from "./workflow-definition-body.js";

export type {
  WorkflowDefinitionScope,
  WorkflowDefinitionSummary,
  WorkflowGateState,
  WorkflowPhaseOutput,
  WorkflowPhaseRunState,
  WorkflowPhaseState,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
  WorkflowRunState,
  WorkflowVersionChainEntry,
} from "./workflow-projection.js";
