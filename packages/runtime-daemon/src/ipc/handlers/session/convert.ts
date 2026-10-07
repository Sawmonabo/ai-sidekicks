// `session.convert`: turns a chat into a project in place, in the repository at the typed path.
// The descriptor is `mutating`, so the gate refuses it on a connection whose `daemon.hello` was
// incompatible.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";

import type { SessionConversion } from "../../../session/convert.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.convert`'s handler calls. */
export interface SessionConvertDeps {
  readonly conversion: Pick<SessionConversion, "convert">;
}

/** Binds `session.convert` onto the registry. */
export function registerSessionConvert(registry: MethodRegistry, deps: SessionConvertDeps): void {
  registerDescribedMethod(
    registry,
    SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.convert"],
    (request) => deps.conversion.convert(request),
  );
}
