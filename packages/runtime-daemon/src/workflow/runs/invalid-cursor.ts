// The refusal of a paging cursor the daemon did not write or that points past the end: a client
// mistake, refused with the code a request whose params fail their schema gets, so a client
// handles both one way.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/** A request's `cursor` the reading store cannot page from; nothing was read. */
export class InvalidCursorError extends DaemonDomainError {
  constructor(reason: string) {
    super(reason, {
      code: "invalid_params",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { issues: [{ code: "custom", path: ["cursor"], message: reason }] },
    });
  }
}
