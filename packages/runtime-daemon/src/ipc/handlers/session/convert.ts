// `session.convert`: turns a chat into a project in place, in the repository at the typed path.
// The descriptor is `mutating`, so the gate refuses it on a connection whose `daemon.hello` was
// incompatible. `session.convertSkippedFileList` reads back, page by page, the files a conversion
// did not copy; it is not `mutating`, so a read-only client can still read it.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";

import type { SessionConversion } from "../../../session/convert.js";

import { registerDescribedMethod } from "../register-described-method.js";

/** What the conversion verbs' handlers call. */
export interface SessionConvertDeps {
  readonly conversion: Pick<SessionConversion, "convert" | "listSkippedFiles">;
}

/** Binds `session.convert` and `session.convertSkippedFileList` onto the registry. */
export function registerSessionConvert(registry: MethodRegistry, deps: SessionConvertDeps): void {
  registerDescribedMethod(
    registry,
    SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.convert"],
    (request) => deps.conversion.convert(request),
  );
  registerDescribedMethod(
    registry,
    SESSION_METHOD_DESCRIPTORS["session.convertSkippedFileList"],
    async (request) => deps.conversion.listSkippedFiles(request),
  );
}
