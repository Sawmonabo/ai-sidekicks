// Each shell's marks: the reader takes only marks carrying this shell's nonce out of its output,
// and real zsh, bash and fish login shells, loaded beside a fixture home's own startup files and
// another tool's hooks, report the prompt, the command's start and its end with its exit code, a
// failing command's and a traced one's included, with the nonce, the prompt command and every
// variable of the launch in no environment a command inherits and the nonce file gone. bash is a
// true login shell, whose history goes to the person's file and whose `logout` runs their
// `.bash_logout`, both where it reads the script through `ENV` and as macOS's own bash, which runs
// its login files from its first prompt command, the managed system profile in place of the other
// where one exists. A shell this machine does not have is skipped.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { makeOrphanGuardDouble } from "../../../__fixtures__/child-doubles.js";
import { findInstalledShell } from "../../../__fixtures__/installed-shell.js";
import { NodePtyHost } from "../../../host/node-pty.js";
import {
  discardMarkNonceFile,
  prepareShellLaunch,
  prepareShellStartupFolders,
} from "../injection.js";
import { type ShellMark, ShellMarkReader } from "../marks.js";
import type { TerminalOperatingSystem } from "../../../operating-system/contract.js";
import { darwinTerminalOperatingSystem } from "../../../operating-system/darwin.js";
import { selectTerminalOperatingSystem } from "../../../operating-system/selector.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NONCE = "0123456789abcdef0123456789abcdef";
const BELL = "\u0007";
const STRING_TERMINATOR = "\u001b\\";

function markText(body: string, nonce: string, terminator = BELL): string {
  return `\u001b]133;${body};nonce=${nonce}${terminator}`;
}

function readText(reader: ShellMarkReader, text: string): { output: string; marks: ShellMark[] } {
  const read = reader.read(encoder.encode(text));
  return { output: decoder.decode(read.output), marks: [...read.marks] };
}

describe("ShellMarkReader", () => {
  it("takes out only this shell's marks; any other mark passes through and ends nothing", () => {
    const foreignMarks = [
      `\u001b]133;D;1${BELL}`,
      markText("D;2", "another-nonce"),
      `\u001b]133;A;aid=person${STRING_TERMINATOR}`,
      markText("C", `${NONCE}0`),
    ].join("");
    const reader = new ShellMarkReader(NONCE);

    const read = readText(
      reader,
      `before${markText("D;1", NONCE)}${markText("A", NONCE)}$ ${foreignMarks}` +
        `${markText("C", NONCE, STRING_TERMINATOR)}out${markText("D", NONCE)}`,
    );

    expect(read.output).toBe(`before$ ${foreignMarks}out`);
    const commandStartOffset = `before$ ${foreignMarks}`.length;
    expect(read.marks).toEqual([
      { kind: "command_end", exitCode: 1, offset: "before".length },
      { kind: "prompt", offset: "before".length },
      { kind: "command_start", offset: commandStartOffset },
      { kind: "command_end", exitCode: null, offset: commandStartOffset + "out".length },
    ]);
  });

  it("holds a mark split across two reads until its terminator, at every split point", () => {
    const mark = markText("D;130", NONCE, STRING_TERMINATOR);
    for (let split = 1; split < mark.length; split += 1) {
      const reader = new ShellMarkReader(NONCE);

      const first = readText(reader, `a${mark.slice(0, split)}`);
      const second = readText(reader, `${mark.slice(split)}b`);

      expect(first).toEqual({ output: "a", marks: [] });
      expect(second).toEqual({
        output: "b",
        marks: [{ kind: "command_end", exitCode: 130, offset: 0 }],
      });
    }
  });

  it("passes on a prefix longer than any of its marks at once, held or not", () => {
    const reader = new ShellMarkReader(NONCE);
    const longBody = "x".repeat(200);

    expect(readText(reader, `\u001b]133;A;${longBody}`)).toEqual({
      output: `\u001b]133;A;${longBody}`,
      marks: [],
    });
    expect(readText(reader, "\u001b]133;A;aid=")).toEqual({ output: "", marks: [] });
    expect(readText(reader, longBody)).toEqual({
      output: `\u001b]133;A;aid=${longBody}`,
      marks: [],
    });
  });
});

// A mark another tool's hooks print, which must reach the output untouched.
const PERSON_PROMPT_MARK = `\u001b]133;A;aid=person${BELL}`;
const FORGED_COMMAND_MARK = `\u001b]133;C;nonce=forged${BELL}`;
const UNMARKED_END_MARK = `\u001b]133;D;0${BELL}`;

// A terminal answers the primary device-attributes query, which a shell may wait on at startup.
const DEVICE_ATTRIBUTES_QUERIES = ["\u001b[c", "\u001b[0c"] as const;
const DEVICE_ATTRIBUTES_ANSWER = "\u001b[?62;22c";

interface ShellCase {
  readonly name: string;
  /** Where the shell is installed; `undefined` skips the case. */
  readonly shellPath: string | undefined;
  /** The fixture home's files, by path inside it. */
  readonly files: Readonly<Record<string, string>>;
  /** A command that prints what each startup file set. */
  readonly checkCommand: string;
  readonly expectedCheckOutput: (home: string) => string;
  /** The marks the fixture's own hooks print, each of which must pass through. */
  readonly passedThrough: readonly string[];
  /** Turns the shell's command tracing on. */
  readonly traceCommand: string;
  /** Writes `grouped` from a group of commands whose output goes to `file`. */
  readonly groupedRedirectCommand: (file: string) => string;
  /** Ends the shell; a bash login shell ends on `logout`, which any other bash refuses. */
  readonly exitCommand: string;
  /** What the shell starts under, given the fixture home; this machine's own when unset. */
  readonly operatingSystem?: ((home: string) => TerminalOperatingSystem) | undefined;
  /** Checks what the shell left in the fixture home once it has exited. */
  readonly checkAfterExit?: (home: string) => void;
}

// macOS's own bash 3.2, which loads the script from its first prompt command.
const APPLE_BASH_PATH = process.platform === "darwin" ? "/bin/bash" : undefined;
// A bash that reads the script through `ENV`: any other on the path.
const ENV_BASH_PATH = ((installed) => (installed === APPLE_BASH_PATH ? undefined : installed))(
  findInstalledShell("bash"),
);

// The smallest stand-in for bash-preexec: it runs `precmd_functions` first in PROMPT_COMMAND, each
// with the command's exit code, keeps the prompt commands already there, and from its DEBUG trap
// runs `preexec_functions` once per line, only for a line typed after its last prompt command.
const BASH_PREEXEC_STAND_IN = [
  "bash_preexec_imported=defined",
  "precmd_functions=()",
  "preexec_functions=()",
  "__fixture_at_prompt=",
  '__fixture_return() { return "$1"; }',
  "__fixture_precmd() {",
  "  local exit_code=$? hook",
  '  for hook in "${precmd_functions[@]}"; do __fixture_return "$exit_code"; "$hook"; done',
  "}",
  "__fixture_await_line() { __fixture_at_prompt=1; }",
  "__fixture_preexec() {",
  '  [ -n "$__fixture_at_prompt" ] && [ "$BASH_COMMAND" != __fixture_precmd ] || return 0',
  "  __fixture_at_prompt=",
  "  local hook",
  '  for hook in "${preexec_functions[@]}"; do "$hook" "$BASH_COMMAND"; done',
  "}",
  "trap __fixture_preexec DEBUG",
  `PROMPT_COMMAND=__fixture_precmd$'\\n'"\${PROMPT_COMMAND-}"$'\\n'__fixture_await_line`,
].join("\n");

// The system profile a bash case reads: the machine's own `/etc/profile` for a bash that reads
// the script through `ENV`, and for macOS's own bash the fixture's, from the managed path where the
// case writes one there and the plain one otherwise.
interface BashSystemProfile {
  readonly operatingSystem?: ((home: string) => TerminalOperatingSystem) | undefined;
  readonly files: Readonly<Record<string, string>>;
  /** What the profile read sets `FIXTURE_SYSTEM_PROFILE` to. */
  readonly expected: string;
}

const MACHINE_SYSTEM_PROFILE: BashSystemProfile = { files: {}, expected: "" };

// macOS's own bash reading the fixture home's system profiles, the managed one where `isManaged`.
function appleSystemProfile(isManaged: boolean): BashSystemProfile {
  return {
    operatingSystem: (home) =>
      darwinTerminalOperatingSystem({
        managedProfilePath: path.join(home, "managed", "profile"),
        profilePath: path.join(home, "etc", "profile"),
      }),
    files: {
      "etc/profile": "export FIXTURE_SYSTEM_PROFILE=plain",
      ...(isManaged ? { "managed/profile": "export FIXTURE_SYSTEM_PROFILE=managed" } : {}),
    },
    expected: isManaged ? "managed" : "plain",
  };
}

// The bash cases, for one bash: beside the person's own prompt command and DEBUG trap, which
// reads the managed profile where `systemProfile` has one, and beside bash-preexec.
function bashCases(
  bashName: string,
  shellPath: string | undefined,
  systemProfiles: { readonly beside: BashSystemProfile; readonly preexec: BashSystemProfile },
): ShellCase[] {
  const login = "$(shopt -q login_shell && echo login)";
  return [
    {
      name: `${bashName} beside the person's PROMPT_COMMAND and DEBUG trap, as a login shell`,
      shellPath,
      operatingSystem: systemProfiles.beside.operatingSystem,
      files: {
        ...systemProfiles.beside.files,
        ".bash_profile": "export FIXTURE_BASH_PROFILE=loaded-bash-profile\n. ~/.bashrc",
        ".bashrc": [
          "export FIXTURE_BASHRC=loaded-bashrc",
          `PROMPT_COMMAND='history -a; printf "\\033]133;A;aid=person\\007"'`,
          "trap 'FIXTURE_DEBUG_TRAP=ran' DEBUG",
        ].join("\n"),
        ".profile": "export FIXTURE_PROFILE=read-though-bash-profile-exists",
        ".bash_logout": "echo logged-out > ~/logout.txt",
      },
      checkCommand:
        `echo "$FIXTURE_SYSTEM_PROFILE,$FIXTURE_BASH_PROFILE,$FIXTURE_BASHRC,$FIXTURE_DEBUG_TRAP,` +
        `$FIXTURE_PROFILE,${login},\${ENV-unset}"`,
      expectedCheckOutput: () =>
        `${systemProfiles.beside.expected},loaded-bash-profile,loaded-bashrc,ran,,login,unset`,
      passedThrough: [PERSON_PROMPT_MARK],
      traceCommand: "set -x",
      groupedRedirectCommand: (file) => `{ echo grouped; } > ${file}`,
      exitCommand: "logout",
      checkAfterExit: (home) => {
        expect(readFileSync(path.join(home, "logout.txt"), "utf8")).toBe("logged-out\n");
        // `history -a` at each prompt wrote the lines typed to the person's own history file.
        expect(readFileSync(path.join(home, ".bash_history"), "utf8")).toContain("\nfalse\n");
      },
    },
    {
      name: `${bashName} beside bash-preexec`,
      shellPath,
      operatingSystem: systemProfiles.preexec.operatingSystem,
      files: {
        ...systemProfiles.preexec.files,
        ".bash_profile": [
          "export FIXTURE_BASH_PROFILE=loaded-bash-profile",
          ". ~/bash-preexec.sh",
          "fixture_precmd() { printf '\\033]133;A;aid=person\\007'; }",
          "fixture_preexec() { FIXTURE_PREEXEC=ran; }",
          "precmd_functions+=(fixture_precmd)",
          "preexec_functions+=(fixture_preexec)",
        ].join("\n"),
        "bash-preexec.sh": BASH_PREEXEC_STAND_IN,
      },
      checkCommand:
        `echo "$FIXTURE_SYSTEM_PROFILE,$FIXTURE_BASH_PROFILE,$FIXTURE_PREEXEC,` + `${login}"`,
      expectedCheckOutput: () => `${systemProfiles.preexec.expected},loaded-bash-profile,ran,login`,
      passedThrough: [PERSON_PROMPT_MARK],
      traceCommand: "set -x",
      groupedRedirectCommand: (file) => `{ echo grouped; } > ${file}`,
      exitCommand: "logout",
    },
  ];
}

const SHELL_CASES: readonly ShellCase[] = [
  {
    name: "zsh beside another tool's precmd and preexec hooks",
    shellPath: findInstalledShell("zsh"),
    files: {
      ".zshenv": "export FIXTURE_ZSHENV=loaded-zshenv",
      ".zprofile": "export FIXTURE_ZPROFILE=loaded-zprofile",
      ".zshrc": [
        "export FIXTURE_ZSHRC=loaded-zshrc",
        "fixture_precmd() { print -n '\\e]133;A;aid=person\\a\\e]133;D;0\\a' }",
        "fixture_preexec() { print -n '\\e]133;C;nonce=forged\\a'; FIXTURE_PREEXEC=ran }",
        "precmd_functions+=(fixture_precmd)",
        "preexec_functions+=(fixture_preexec)",
      ].join("\n"),
      ".zlogin": "export FIXTURE_ZLOGIN=loaded-zlogin",
    },
    checkCommand: [
      'echo "$FIXTURE_ZSHENV,$FIXTURE_ZPROFILE,$FIXTURE_ZSHRC,',
      '$FIXTURE_ZLOGIN,$FIXTURE_PREEXEC,$ZDOTDIR"',
    ].join(""),
    expectedCheckOutput: (home) =>
      `loaded-zshenv,loaded-zprofile,loaded-zshrc,loaded-zlogin,ran,${home}`,
    passedThrough: [PERSON_PROMPT_MARK, UNMARKED_END_MARK, FORGED_COMMAND_MARK],
    traceCommand: "set -x",
    groupedRedirectCommand: (file) => `{ echo grouped; } > ${file}`,
    exitCommand: "exit",
  },
  ...bashCases("bash", ENV_BASH_PATH, {
    beside: MACHINE_SYSTEM_PROFILE,
    preexec: MACHINE_SYSTEM_PROFILE,
  }),
  ...bashCases("macOS's own bash", APPLE_BASH_PATH, {
    beside: appleSystemProfile(true),
    preexec: appleSystemProfile(false),
  }),
  {
    name: "fish beside another handler of its prompt event",
    shellPath: findInstalledShell("fish"),
    files: {
      ".config/fish/config.fish": [
        "set -gx FIXTURE_FISH loaded-fish",
        "function fixture_prompt --on-event fish_prompt",
        "    printf '\\e]133;A;aid=person\\a'",
        "end",
      ].join("\n"),
    },
    checkCommand: 'echo "$FIXTURE_FISH"',
    expectedCheckOutput: () => "loaded-fish",
    passedThrough: [PERSON_PROMPT_MARK],
    traceCommand: "set -g fish_trace 1",
    groupedRedirectCommand: (file) => `begin; echo grouped; end > ${file}`,
    exitCommand: "exit",
  },
];

function writeFixtureHome(files: Readonly<Record<string, string>>): string {
  const home = mkdtempSync(path.join(tmpdir(), "shell-marks-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(home, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${content}\n`);
  }
  return home;
}

// The marks without their offsets, which depend on what the shell drew around them.
function markKinds(marks: readonly ShellMark[]): unknown[] {
  return marks.map((mark) =>
    mark.kind === "command_end"
      ? { kind: mark.kind, exitCode: mark.exitCode }
      : { kind: mark.kind },
  );
}

const PROMPT_TIMEOUT_MS = 15_000;

describe.skipIf(process.platform === "win32")("each shell's marks in a real login shell", () => {
  for (const shellCase of SHELL_CASES) {
    const { shellPath } = shellCase;
    it.skipIf(shellPath === undefined)(
      shellCase.name,
      async () => {
        if (shellPath === undefined) {
          throw new Error(`${shellCase.name} runs only where its shell is installed`);
        }
        const home = writeFixtureHome(shellCase.files);
        const runFolder = mkdtempSync(path.join(tmpdir(), "shell-marks-run-"));
        const operatingSystem =
          shellCase.operatingSystem?.(home) ??
          selectTerminalOperatingSystem(process.platform, process.env);
        const host = new NodePtyHost(makeOrphanGuardDouble(), operatingSystem);
        const launch = await prepareShellLaunch({
          shellPath,
          environment: [
            ["HOME", home],
            ["PATH", process.env["PATH"] ?? "/usr/bin:/bin"],
            ["TERM", "xterm-256color"],
          ],
          startupFolders: await prepareShellStartupFolders(runFolder),
          operatingSystem,
        });
        try {
          const { markNonce } = launch;
          if (markNonce === null) {
            throw new Error(`${shellPath} was given no script`);
          }
          const { nonce, nonceFile } = markNonce;
          // The nonce reaches the shell only through its file.
          expect(launch.environment.some(([, value]) => value.includes(nonce))).toBe(false);
          const reader = new ShellMarkReader(nonce);
          const marks: ShellMark[] = [];
          let output = "";
          let sessionId = "";
          let hasExited = false;
          host.setOnExit(() => {
            hasExited = true;
          });
          host.setOnData((_sessionId, chunk) => {
            const read = reader.read(chunk);
            const text = decoder.decode(read.output, { stream: true });
            output += text;
            marks.push(...read.marks);
            if (DEVICE_ATTRIBUTES_QUERIES.some((query) => text.includes(query))) {
              void host.write(sessionId, encoder.encode(DEVICE_ATTRIBUTES_ANSWER));
            }
          });
          ({ session_id: sessionId } = await host.spawn({
            kind: "spawn_request",
            command: launch.command,
            args: [...launch.args],
            env: launch.environment.map(([name, value]): [string, string] => [name, value]),
            cwd: home,
            rows: 24,
            cols: 200,
          }));

          // Each line typed at a prompt reports its start, its end and the next prompt.
          const run = async (
            command: string,
          ): Promise<{ marks: readonly ShellMark[]; output: string }> => {
            const marksFrom = marks.length;
            const outputFrom = output.length;
            await host.write(sessionId, encoder.encode(`${command}\r`));
            await vi.waitFor(
              () => {
                expect(markKinds(marks.slice(marksFrom)).at(-1)).toEqual({ kind: "prompt" });
              },
              { timeout: PROMPT_TIMEOUT_MS, interval: 20 },
            );
            return { marks: marks.slice(marksFrom), output: output.slice(outputFrom) };
          };
          const ranWith = (exitCode: number): unknown[] => [
            { kind: "command_start" },
            { kind: "command_end", exitCode },
            { kind: "prompt" },
          ];

          await vi.waitFor(
            () => {
              // On a timeout the shell's output says what it showed instead of a prompt.
              expect(markKinds(marks), output).toEqual([
                { kind: "command_end", exitCode: null },
                { kind: "prompt" },
              ]);
            },
            { timeout: PROMPT_TIMEOUT_MS, interval: 20 },
          );

          // The script deleted the nonce's file, and no variable a command inherits names it, the
          // prompt command or any variable the launch set.
          expect(existsSync(nonceFile)).toBe(false);
          const inherited = await run("env");
          expect(markKinds(inherited.marks)).toEqual(ranWith(0));
          expect(inherited.output).toContain(`HOME=${home}`);
          expect(inherited.output).not.toContain(nonce);
          expect(inherited.output).not.toContain(nonceFile);
          const launchNames = launch.environment
            .map(([name]) => name)
            .filter((name) => name.startsWith("SIDEKICKS_"));
          for (const name of [...launchNames, "PROMPT_COMMAND"]) {
            expect(inherited.output).not.toContain(`${name}=`);
          }

          // The start mark a group's first command writes reaches the terminal, never the file
          // the group's output goes to.
          const groupedFile = path.join(home, "grouped.txt");
          const grouped = await run(shellCase.groupedRedirectCommand(groupedFile));
          expect(markKinds(grouped.marks)).toEqual(ranWith(0));
          expect(readFileSync(groupedFile, "utf8")).toBe("grouped\n");

          // A failing command's end mark carries its own exit code, not the hooks' own.
          expect(markKinds((await run("false")).marks)).toEqual(ranWith(1));

          // With tracing on, the marks still come and the trace never prints the nonce.
          await run(shellCase.traceCommand);
          expect(markKinds((await run("true")).marks)).toEqual(ranWith(0));

          const check = await run(shellCase.checkCommand);
          expect(markKinds(check.marks)).toEqual(ranWith(0));
          expect(check.output).toContain(shellCase.expectedCheckOutput(home));

          for (const passed of shellCase.passedThrough) {
            expect(output).toContain(passed);
          }
          expect(output).not.toContain(nonce);
          // The shell exits by itself rather than being left to the drain's signals: fish dies on
          // the drain's SIGTERM, and a write still on its way would then reach a closed terminal.
          await host.write(sessionId, encoder.encode(`${shellCase.exitCommand}\r`));
          await vi.waitFor(
            () => {
              expect(hasExited).toBe(true);
            },
            { timeout: PROMPT_TIMEOUT_MS, interval: 20 },
          );
          shellCase.checkAfterExit?.(home);
        } finally {
          await host.shutdown({ perSessionTimeoutMs: 2_000, hostTimeoutMs: 2_000 });
          if (launch.markNonce !== null) {
            await discardMarkNonceFile(launch.markNonce);
          }
          rmSync(home, { recursive: true, force: true });
          rmSync(runFolder, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
});
