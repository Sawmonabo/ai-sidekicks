// The service's side of the askpass program: a local socket in a folder only the person's account
// can open, the shell launcher git and ssh run, and the owners of the questions. Whoever runs git
// with a question to answer (a clone, later a provider's git) registers as an owner and passes the
// environment it is given; each question the program carries arrives at that owner alone, chosen
// by the random id in that environment, and its answer goes back to the program and is kept
// nowhere. The launcher hands the question on as an argument, never to a command interpreter that
// would read it, since an ssh server writes that text. A folder a stopped service left is removed
// at the next start.

import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { ServiceLogWriter } from "../../../daemon/service-log.js";
import { describeRejection } from "../../../rejection.js";
import { quoteForPosixShell } from "../../../shell-quoting.js";

// Beside this module with its extension, so the source and the build each find their own.
const PROGRAM_PATH = fileURLToPath(
  new URL(`./program${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

// The variable that names a question's owner to the program.
const OWNER_VARIABLE = "SIDEKICKS_ASKPASS_OWNER";

// Every answer is typed out of sight but git's `Username for '…': ` and ssh's host-key question,
// `Are you sure you want to continue connecting (yes/no/[fingerprint])? `, since a question no rule
// knows may ask for a secret.
const UNMASKED_PROMPT = /^Username for |\(yes\/no[^)]*\)\? ?$/i;

// The start of each folder the broker makes in the temporary folder, and its socket's name there.
const FOLDER_PREFIX = "sk-askpass-";
const SOCKET_NAME = "s";

// The bytes of an owner's id: random, so one owner's id never tells another's.
const OWNER_ID_BYTES = 16;

// The longest request line read from the program; a longer one is no question.
const REQUEST_MAX_BYTES = 16 * 1024;

/** One question git or ssh asks, as the owner receives it. */
export interface AskpassQuestion {
  /** The question in git's or ssh's own words. */
  readonly prompt: string;
  /** Whether the answer is a secret typed out of sight. */
  readonly isMasked: boolean;
  /** Aborts when the program goes away unanswered: git gave up or was stopped. */
  readonly signal: AbortSignal;
}

/**
 * Answers one question: resolves with the answer, one line, or rejects to refuse it, which makes
 * git give up on the question.
 */
export type AskpassAnswerer = (question: AskpassQuestion) => Promise<string>;

/** A registered owner: the environment its git runs with, and the release that ends it. */
export interface AskpassOwner {
  /** `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force` and the owner's id. */
  readonly environment: Readonly<Record<string, string>>;
  /** Refuses every question still open and every later one. */
  release(): void;
}

// A question the program is waiting on, by its connection.
interface OpenQuestion {
  readonly owner: string;
  readonly abort: () => void;
}

/**
 * Routes the askpass program's questions to their owners. {@link AskpassBroker.start} opens it;
 * {@link AskpassBroker.close} refuses everything open and removes its socket and launcher.
 */
export class AskpassBroker {
  readonly #server: Server;
  readonly #folder: string;
  readonly #launcherPath: string;
  readonly #owners = new Map<string, AskpassAnswerer>();
  readonly #openQuestions = new Map<Socket, OpenQuestion>();

  private constructor(server: Server, folder: string, launcherPath: string) {
    this.#server = server;
    this.#folder = folder;
    this.#launcherPath = launcherPath;
    server.on("connection", (socket) => {
      this.#serve(socket);
    });
  }

  /**
   * Whether the broker has a launcher for git and ssh to run on `platform`. Only the POSIX shell
   * launcher ships, so on Windows the broker is never started.
   */
  static hasLauncherOn(platform: NodeJS.Platform): boolean {
    return platform !== "win32";
  }

  /**
   * Opens the broker, first removing the folders a stopped service left: a folder only the
   * person's account opens, holding the launcher and the socket. A folder that cannot be removed
   * is written to the service log; rejects when the broker's own folder, launcher or socket cannot
   * be made.
   */
  static async start(writeServiceLog: ServiceLogWriter): Promise<AskpassBroker> {
    await removeLeftoverFolders(writeServiceLog);
    // Short: a socket's path is capped near 104 bytes on macOS.
    const folder = await mkdtemp(path.join(tmpdir(), FOLDER_PREFIX));
    const socketPath = path.join(folder, SOCKET_NAME);
    const launcherPath = path.join(folder, "askpass");
    await writeFile(launcherPath, launcherText(socketPath), { mode: 0o700 });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return new AskpassBroker(server, folder, launcherPath);
  }

  /** Registers an owner whose git questions `answer` receives, until it is released. */
  register(answer: AskpassAnswerer): AskpassOwner {
    const owner = randomBytes(OWNER_ID_BYTES).toString("hex");
    this.#owners.set(owner, answer);
    return {
      environment: {
        GIT_ASKPASS: this.#launcherPath,
        SSH_ASKPASS: this.#launcherPath,
        SSH_ASKPASS_REQUIRE: "force",
        [OWNER_VARIABLE]: owner,
      },
      release: () => {
        this.#owners.delete(owner);
        for (const [socket, question] of this.#openQuestions) {
          if (question.owner === owner) socket.destroy();
        }
      },
    };
  }

  /** Refuses every open question and removes the socket and launcher. */
  async close(): Promise<void> {
    this.#owners.clear();
    for (const socket of this.#openQuestions.keys()) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
    await rm(this.#folder, { recursive: true, force: true });
  }

  // One connection is one question: a request line in, an answer line out, or a close.
  #serve(socket: Socket): void {
    socket.setEncoding("utf8");
    let received = "";
    const onData = (chunk: string): void => {
      received += chunk;
      const lineEnd = received.indexOf("\n");
      if (lineEnd === -1) {
        if (received.length > REQUEST_MAX_BYTES) socket.destroy();
        return;
      }
      socket.off("data", onData);
      this.#ask(socket, received.slice(0, lineEnd));
    };
    socket.on("data", onData);
    // A program that went away mid-question surfaces through the question's signal.
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.#openQuestions.get(socket)?.abort();
      this.#openQuestions.delete(socket);
    });
  }

  #ask(socket: Socket, requestLine: string): void {
    const request = parseRequest(requestLine);
    const answer = request === null ? undefined : this.#owners.get(request.owner);
    if (request === null || answer === undefined) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    this.#openQuestions.set(socket, {
      owner: request.owner,
      abort: () => {
        controller.abort();
      },
    });
    answer({
      prompt: request.prompt,
      isMasked: !UNMASKED_PROMPT.test(request.prompt),
      signal: controller.signal,
    }).then(
      (reply) => {
        this.#openQuestions.delete(socket);
        // An answer is one line; anything after a break never reaches git.
        socket.end(`${reply.split(/[\r\n]/, 1)[0] ?? ""}\n`);
      },
      () => {
        this.#openQuestions.delete(socket);
        socket.destroy();
      },
    );
  }
}

// The program's one request line, or `null` for a line that is not one, which is refused.
function parseRequest(line: string): { readonly owner: string; readonly prompt: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { owner, prompt } = parsed as Record<string, unknown>;
  return typeof owner === "string" && typeof prompt === "string" ? { owner, prompt } : null;
}

// The shell file git and ssh run: Node running the program with the socket, the owner from the
// environment, and the question git or ssh passes, quoted so the shell never reads it.
function launcherText(socketPath: string): string {
  return [
    "#!/bin/sh",
    `exec ${[process.execPath, PROGRAM_PATH, socketPath].map(quoteForPosixShell).join(" ")} ` +
      `"$${OWNER_VARIABLE}" "$@"`,
    "",
  ].join("\n");
}

// Removes each broker folder of this account that a stopped service left: made before this process
// started, and whose socket no broker listens on, so a live broker's folder is never reached.
async function removeLeftoverFolders(writeServiceLog: ServiceLogWriter): Promise<void> {
  const temporaryFolder = tmpdir();
  const uid = process.getuid?.();
  for (const name of await readdir(temporaryFolder)) {
    if (!name.startsWith(FOLDER_PREFIX)) continue;
    const folder = path.join(temporaryFolder, name);
    try {
      const stats = await lstat(folder);
      const isOwnLeftover =
        stats.isDirectory() &&
        (uid === undefined || stats.uid === uid) &&
        stats.mtimeMs < performance.timeOrigin &&
        !(await isListenedOn(path.join(folder, SOCKET_NAME)));
      if (isOwnLeftover) await rm(folder, { recursive: true, force: true });
    } catch (error) {
      writeServiceLog(
        `The askpass folder ${folder} a stopped service left could not be removed: ` +
          describeRejection(error),
      );
    }
  }
}

// Whether a broker listens on the socket at `socketPath`.
function isListenedOn(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    // No socket, or one nothing listens on, is a leftover's.
    probe.once("error", () => {
      resolve(false);
    });
  });
}
