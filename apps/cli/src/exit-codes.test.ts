import { JsonRpcRemoteError } from "@ai-sidekicks/client-sdk";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { describe, expect, it } from "vitest";

import { exitCodeForFailure } from "./exit-codes.js";

describe("exitCodeForFailure", () => {
  it.each([
    [JsonRpcErrorCode.ParseError, 65],
    [JsonRpcErrorCode.InvalidRequest, 64],
    [JsonRpcErrorCode.MethodNotFound, 64],
    [JsonRpcErrorCode.InvalidParams, 64],
    [JsonRpcErrorCode.InternalError, 70],
  ])("maps the daemon's code %i to exit code %i", (code, exitCode) => {
    expect(exitCodeForFailure(new JsonRpcRemoteError(code, "refused", undefined))).toBe(exitCode);
  });
});
