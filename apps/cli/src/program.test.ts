import {
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTransportUnavailableError,
} from "@ai-sidekicks/client-sdk";
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

async function runBuilt(
  buildProgram: (context: CommandContext) => Command,
  args: readonly string[],
): Promise<RunOutcome> {
  let stdout = "";
  let stderr = "";
  const context: CommandContext = {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
  };
  const exitCode = await runProgram(buildProgram(context), args);
  return { exitCode, stdout, stderr };
}

const countFormat = new Intl.NumberFormat();

function run(args: readonly string[], failure: unknown = undefined): Promise<RunOutcome> {
  return runBuilt((context) => createTestProgram(context, failure), args);
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

    expect(await run(["help"])).toEqual(help);

    for (const args of [
      ["daemon", "--help"],
      ["help", "daemon"],
      ["daemon", "help"],
    ]) {
      const groupHelp = await run(args);
      expect(groupHelp.exitCode).toBe(0);
      expect(groupHelp.stdout).toMatch(/^Usage: sidekicks daemon \[options\] \[command\]\n/);
      expect(groupHelp.stderr).toBe("");
    }

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

  it("answers help and refuses a bare invocation and an unknown word with no command registered", async () => {
    const bare = await runBuilt(createProgram, []);
    expect(bare.exitCode).toBe(64);
    expect(bare.stdout).toBe("");
    expect(bare.stderr.startsWith("Usage: sidekicks [options] [command]\n")).toBe(true);

    const help = await runBuilt(createProgram, ["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.startsWith("Usage: sidekicks [options] [command]\n")).toBe(true);
    expect(help.stderr).toBe("");

    expect(await runBuilt(createProgram, ["nope", "extra"])).toEqual({
      exitCode: 64,
      stdout: "",
      stderr: "error: unknown command 'nope'\n",
    });
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
      "a value with no string form",
      Object.create(null),
      70,
      "error: [Object: null prototype] {}\n",
    ],
    [
      "a raw argument refusal from a command body",
      new InvalidArgumentError("Not a session id."),
      64,
      "error: Not a session id.\n",
    ],
    [
      "an unreachable daemon",
      new JsonRpcTransportUnavailableError("/tmp/daemon.sock", new Error("refused")),
      69,
      "error: The background service is not answering at /tmp/daemon.sock: refused\n",
    ],
    [
      "a connection closed mid-call",
      new JsonRpcTransportClosedError(new Error("reset")),
      69,
      "error: The connection to the background service closed: reset\n",
    ],
    [
      "a service repairing its database file, with its count",
      new JsonRpcRemoteError(-32600, "The service is repairing its database file", {
        type: "daemon.repairing",
        fields: { progress: { done: 1200, total: 4000 } },
      }),
      69,
      // In the machine's own locale, as the command line writes a count.
      `error: Repairing saved sessions after an unexpected shutdown · ${countFormat.format(1200)} ` +
        `of ${countFormat.format(4000)}\n`,
    ],
    [
      "a service repairing its database file, with no count",
      new JsonRpcRemoteError(-32600, "The service is repairing its database file", {
        type: "daemon.repairing",
        fields: {},
      }),
      69,
      "error: Repairing saved sessions after an unexpected shutdown…\n",
    ],
    [
      "a daemon code with no exit code",
      new JsonRpcRemoteError(-32000, "server error", undefined),
      70,
      "error: server error\n" +
        "error: The background service returned error code -32000, which has no exit code\n",
    ],
  ])(
    "reports %s as one line per failure on stderr only, with no stack",
    async (_case, failure, exitCode, message) => {
      expect(await run(["fail"], failure)).toEqual({ exitCode, stdout: "", stderr: message });
    },
  );
});
