import { JsonRpcRemoteError, JsonRpcTransportUnavailableError } from "@ai-sidekicks/client-sdk";
import { type Command, InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";

import packageManifest from "../package.json" with { type: "json" };
import type { CommandContext } from "./command-context.js";
import { createProgram, runProgram } from "./program.js";

interface RunOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Not a whole number.");
  }
  return Number(value);
}

// A program with test-only commands added the way a command author adds them: `echo`, `count`
// with a custom argument parser, `fail`, which throws `failure`, and `daemon status` in a group.
function createTestProgram(context: CommandContext, failure: unknown): Command {
  const program = createProgram(context);
  program
    .command("echo")
    .argument("<text>")
    .action((text: string) => {
      context.stdout.write(`${text}\n`);
    });
  program
    .command("count")
    .argument("<amount>", "a whole number", parseCount)
    .action((amount: number) => {
      context.stdout.write(`${amount}\n`);
    });
  program.command("fail").action(async () => {
    throw failure;
  });
  program
    .command("daemon")
    .command("status")
    .action(() => {
      context.stdout.write("running\n");
    });
  return program;
}

async function run(args: readonly string[], failure: unknown = undefined): Promise<RunOutcome> {
  let stdout = "";
  let stderr = "";
  const context: CommandContext = {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
  };
  const exitCode = await runProgram(createTestProgram(context, failure), args, context);
  return { exitCode, stdout, stderr };
}

describe("runProgram", () => {
  it("writes a command's result to stdout only and exits 0, nested commands included", async () => {
    expect(await run(["echo", "hello"])).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
    expect(await run(["daemon", "status"])).toEqual({
      exitCode: 0,
      stdout: "running\n",
      stderr: "",
    });
  });

  it("writes help and the version to stdout only and exits 0", async () => {
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toMatch(/^Usage: sidekicks \[options\] \[command\]\n/);
    expect(help.stderr).toBe("");

    const nestedHelp = await run(["daemon", "--help"]);
    expect(nestedHelp.exitCode).toBe(0);
    expect(nestedHelp.stdout).toMatch(/^Usage: sidekicks daemon \[options\] \[command\]\n/);
    expect(nestedHelp.stderr).toBe("");

    expect(await run(["--version"])).toEqual({
      exitCode: 0,
      stdout: `${packageManifest.version}\n`,
      stderr: "",
    });
  });

  it.each([
    ["an unknown command", ["nope"], "error: unknown command 'nope'\n"],
    ["an unknown option", ["echo", "--nope", "hi"], "error: unknown option '--nope'\n"],
    ["an unknown nested command", ["daemon", "nope"], "error: unknown command 'nope'\n"],
    ["a missing argument", ["echo"], "error: missing required argument 'text'\n"],
    [
      "an argument its parser refuses",
      ["count", "many"],
      "error: command-argument value 'many' is invalid for argument 'amount'. " +
        "Not a whole number.\n",
    ],
  ])("refuses %s on stderr only with exit 64", async (_case, args, message) => {
    expect(await run(args)).toEqual({ exitCode: 64, stdout: "", stderr: message });
  });

  it.each([
    ["the program", [], "Usage: sidekicks [options] [command]\n"],
    ["a group", ["daemon"], "Usage: sidekicks daemon [options] [command]\n"],
  ])("refuses a bare invocation of %s with its usage on stderr", async (_case, args, usage) => {
    const outcome = await run(args);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr.startsWith(usage)).toBe(true);
  });

  it.each([
    ["a plain error", new Error("disk full"), 70, "error: disk full\n"],
    ["a thrown string", "disk full", 70, "error: disk full\n"],
    [
      "a daemon invalid-params error",
      new JsonRpcRemoteError(-32602, "bad session id", undefined),
      64,
      "error: bad session id\n",
    ],
    [
      "a daemon parse error",
      new JsonRpcRemoteError(-32700, "unreadable request", undefined),
      65,
      "error: unreadable request\n",
    ],
    [
      "an unreachable daemon",
      new JsonRpcTransportUnavailableError("/tmp/daemon.sock", new Error("refused")),
      70,
      "error: The daemon's socket /tmp/daemon.sock cannot be reached: refused\n",
    ],
    [
      "a daemon code with no exit code",
      new JsonRpcRemoteError(-32000, "server error", undefined),
      70,
      "error: server error\nerror: The daemon's error code -32000 has no exit code\n",
    ],
  ])(
    "reports %s as one line per failure on stderr only, with no stack",
    async (_case, failure, exitCode, message) => {
      expect(await run(["fail"], failure)).toEqual({ exitCode, stdout: "", stderr: message });
    },
  );
});
