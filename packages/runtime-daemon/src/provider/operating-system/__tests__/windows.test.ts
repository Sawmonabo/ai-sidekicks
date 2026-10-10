// A provider installed by npm or pnpm on Windows is a `.cmd` shim, which Node starts only through a
// shell; the daemon runs the shim's script under Node instead, so the script must be read from the
// shim exactly. The texts are what each package manager's own shim writer produces.

import { describe, expect, it } from "vitest";

import { readCommandShimScript } from "../windows.js";

// Written by `cmd-shim` 9.0.2, npm's shim writer, for a script whose `#!` line names `node`.
const NPM_NODE_SHIM =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\..\\pkg\\bin\\codex.js" %*\r\n';

// Written by `@zkochan/cmd-shim` 9.0.8, pnpm's shim writer, for the same script.
const PNPM_NODE_SHIM =
  '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\pkg\\bin\\codex.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\pkg\\bin\\codex.js" %*\r\n)\r\n';

// Written by `cmd-shim` 9.0.2 for a script whose `#!` line names `/bin/sh`.
const NPM_SHELL_SHIM =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\/bin/sh.exe" (\r\n  SET "_prog=%dp0%\\/bin/sh.exe"\r\n) ELSE (\r\n  SET "_prog=/bin/sh"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\..\\pkg\\bin\\tool.sh" %*\r\n';

describe("a Windows command shim", () => {
  it("names the Node script npm's and pnpm's shims run, and no script for another program", () => {
    expect(readCommandShimScript(NPM_NODE_SHIM)).toBe("..\\pkg\\bin\\codex.js");
    expect(readCommandShimScript(PNPM_NODE_SHIM)).toBe("..\\pkg\\bin\\codex.js");
    expect(readCommandShimScript(NPM_SHELL_SHIM)).toBeUndefined();
  });
});
