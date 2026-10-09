// The program Codex runs as the daemon's pre-tool and post-tool hooks, as
// `node program <socket> <event>`: it hands the hook's input to the daemon over the socket and
// prints the daemon's answer the way Codex reads a hook's output. A pre-tool hook that cannot reach
// the daemon blocks its call rather than let it run unchecked.
//
// The build writes it as an entry of its own beside the hook server, so Node runs the program.

import { createConnection } from "node:net";
import { text } from "node:stream/consumers";

import type { CodexHookAnswer } from "./server.js";
import { describeRejection } from "../../../../rejection.js";

// Codex blocks a pre-tool call whose hook exits with this code, and shows the model its stderr.
const BLOCKING_EXIT_CODE = 2;

async function main(): Promise<void> {
  const [, , socketPath, eventName] = process.argv;
  try {
    if (socketPath === undefined) {
      throw new Error("no daemon socket was named");
    }
    const input: unknown = JSON.parse(await text(process.stdin));
    printAnswer(await askDaemon(socketPath, input));
  } catch (error) {
    const detail = describeRejection(error);
    process.stderr.write(`The background service could not answer this hook: ${detail}\n`);
    // A post-tool hook's failure leaves the finished call as it was.
    process.exitCode = eventName === "PostToolUse" ? 1 : BLOCKING_EXIT_CODE;
  }
}

// One line out, one line back; the daemon ends the connection after answering.
async function askDaemon(socketPath: string, input: unknown): Promise<CodexHookAnswer> {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify({ input })}\n`);
  let received = "";
  for await (const chunk of socket) {
    received += String(chunk);
    const end = received.indexOf("\n");
    if (end >= 0) {
      socket.destroy();
      return JSON.parse(received.slice(0, end)) as CodexHookAnswer;
    }
  }
  throw new Error("the daemon closed the connection without an answer");
}

function printAnswer(answer: CodexHookAnswer): void {
  if (answer.decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: answer.reason,
        },
      }),
    );
  } else if (answer.decision === "context") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: answer.additionalContext,
        },
      }),
    );
  }
}

await main();
