// Which detail renders which entity kind. Total over the closed set, by type.
//
// `Record<ConsoleEntityKind, …>` rather than a lookup with a fallback: the entity
// kinds are declared once in `store/entities.ts`, and a thirteenth added there
// should fail to compile HERE — where somebody has to decide what its record says —
// rather than reach a deck that renders it as a blank pane. There is no default
// arm for the same reason: a default is a body that claims to know a kind nobody
// wrote a record for.
//
// The table is the only module that imports all twelve details, and none of them
// imports it. That is what keeps the shared vocabulary (`entity-facets.ts`) below
// both, and it is why `EntityDetailProps` lives there rather than here.

import type { ConsoleEntityKind } from "../../../store/index.js";
import { AgentEntityDetail } from "./AgentEntityDetail.js";
import { ApprovalEntityDetail } from "./ApprovalEntityDetail.js";
import { ArtifactEntityDetail } from "./ArtifactEntityDetail.js";
import { BrowserPageEntityDetail } from "./BrowserPageEntityDetail.js";
import { ChannelEntityDetail } from "./ChannelEntityDetail.js";
import { ParticipantEntityDetail } from "./ParticipantEntityDetail.js";
import { RunEntityDetail } from "./RunEntityDetail.js";
import { SessionEntityDetail } from "./SessionEntityDetail.js";
import { WorkflowDefinitionEntityDetail } from "./WorkflowDefinitionEntityDetail.js";
import { WorkflowRunEntityDetail } from "./WorkflowRunEntityDetail.js";
import { WorkspaceEntityDetail } from "./WorkspaceEntityDetail.js";
import { WorktreeEntityDetail } from "./WorktreeEntityDetail.js";
import type { EntityDetailProps } from "./entity-facets.js";

/** One kind's record body. Every detail takes the same props and renders its own. */
export type EntityDetailComponent = (props: EntityDetailProps) => React.JSX.Element;

/** The table, in the order `CONSOLE_ENTITY_KINDS` declares. */
export const ENTITY_DETAIL_BY_KIND: Readonly<Record<ConsoleEntityKind, EntityDetailComponent>> = {
  session: SessionEntityDetail,
  participant: ParticipantEntityDetail,
  channel: ChannelEntityDetail,
  run: RunEntityDetail,
  agent: AgentEntityDetail,
  workspace: WorkspaceEntityDetail,
  worktree: WorktreeEntityDetail,
  artifact: ArtifactEntityDetail,
  approval: ApprovalEntityDetail,
  "workflow-definition": WorkflowDefinitionEntityDetail,
  "workflow-run": WorkflowRunEntityDetail,
  "browser-page": BrowserPageEntityDetail,
};
