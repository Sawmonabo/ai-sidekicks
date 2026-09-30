// Which detail renders which entity kind.
//
// The keys are the kinds the inspector's address admits, read off that address, so a
// kind added to it fails to compile here until it has a record body.
//
// The table is the only module that imports every detail, and none of them
// imports it. That keeps the shared vocabulary (`entity-facets.ts`) below both,
// which is why `EntityDetailProps` lives there rather than here.

import type { PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { WorkspaceEntityDetail } from "./components/WorkspaceEntityDetail.js";
import { WorktreeEntityDetail } from "./components/WorktreeEntityDetail.js";
import type { EntityDetailProps } from "./entity-facets.js";

/** One kind's record body. Every detail takes the same props and renders its own. */
export type EntityDetailComponent = (props: EntityDetailProps) => React.JSX.Element;

/** The entity kinds the inspector opens over, each with a record body. */
export type EntityDetailKind = PaneContextOf<"inspector">["entity"]["kind"];

/** The record body for each entity kind the inspector opens over. */
export const ENTITY_DETAIL_BY_KIND: Readonly<Record<EntityDetailKind, EntityDetailComponent>> = {
  workspace: WorkspaceEntityDetail,
  worktree: WorktreeEntityDetail,
};
