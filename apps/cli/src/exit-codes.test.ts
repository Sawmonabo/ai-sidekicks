import {
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportUnavailableError,
} from "@ai-sidekicks/client-sdk";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { describe, expect, it } from "vitest";

import { exitCodeForFailure, UnmappedExitCodeError } from "./exit-codes.js";

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

  it("maps a daemon that cannot be reached or whose connection closed to 69", () => {
    const unreachable = new JsonRpcTransportUnavailableError("/tmp/daemon.sock", new Error("gone"));
    expect(exitCodeForFailure(unreachable)).toBe(69);
    expect(exitCodeForFailure(new JsonRpcTransportClosedError(undefined))).toBe(69);
  });

  it("throws for a daemon code with no exit code", () => {
    const unassigned = new JsonRpcRemoteError(-32000, "server error", undefined);
    expect(() => exitCodeForFailure(unassigned)).toThrow(UnmappedExitCodeError);
  });
});
