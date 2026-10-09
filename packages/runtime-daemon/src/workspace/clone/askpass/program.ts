// The askpass program git and ssh run when they need an answer from the person: a user name, a
// password or token, a key's passphrase, or whether to trust a host's key. It carries the question
// to the service over the local socket its launcher names, prints the answer the service sends
// back as one line, and exits 0; it exits 1, printing nothing, when the service refuses or is
// gone, so git gives up on the question. The launcher runs it as
// `node program <socket> <owner> <prompt>`, the owner naming whose question it is.
//
// It runs as its own process from its own file, so it imports only Node's built-in modules.

import { connect } from "node:net";

const [socketPath, owner, prompt] = process.argv.slice(2);

if (socketPath === undefined || owner === undefined || owner === "") {
  process.exit(1);
}

const connection = connect(socketPath);
let received = "";
let isAnswered = false;

connection.setEncoding("utf8");
connection.on("connect", () => {
  connection.write(`${JSON.stringify({ owner, prompt: prompt ?? "" })}\n`);
});
connection.on("data", (chunk: string) => {
  received += chunk;
  const lineEnd = received.indexOf("\n");
  if (lineEnd === -1) return;
  isAnswered = true;
  process.stdout.write(`${received.slice(0, lineEnd)}\n`, () => {
    process.exit(0);
  });
  connection.destroy();
});
// A refused or lost question: git reads no answer from a program that exits 1.
connection.on("error", () => {
  process.exit(1);
});
connection.on("close", () => {
  if (!isAnswered) process.exit(1);
});
