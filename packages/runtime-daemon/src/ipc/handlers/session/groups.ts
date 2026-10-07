// The person's session group verbs: `session.groupCreate`, `session.groupMove`,
// `session.groupRename` and `session.groupUngroup`. A client reads every change from the live
// sessions list.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_GROUP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/groups";

import type { SessionGroupService } from "../../../session/groups/service.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the group verbs call. */
export interface SessionGroupMethodsDeps {
  readonly groups: Pick<SessionGroupService, "create" | "move" | "rename" | "ungroup">;
}

/** Binds the four group verbs onto the registry. A second binding on one registry throws. */
export function registerSessionGroupMethods(
  registry: MethodRegistry,
  deps: SessionGroupMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_GROUP_METHOD_DESCRIPTORS["session.groupCreate"],
    async (request) => deps.groups.create(request),
  );
  registerDescribedMethod(
    registry,
    SESSION_GROUP_METHOD_DESCRIPTORS["session.groupMove"],
    async (request) => {
      await deps.groups.move(request);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_GROUP_METHOD_DESCRIPTORS["session.groupRename"],
    async (request) => {
      await deps.groups.rename(request);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    SESSION_GROUP_METHOD_DESCRIPTORS["session.groupUngroup"],
    async (request) => {
      await deps.groups.ungroup(request);
      return {};
    },
  );
}
