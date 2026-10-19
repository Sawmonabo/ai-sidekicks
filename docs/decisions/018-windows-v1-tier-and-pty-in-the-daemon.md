# ADR-018: Windows V1 Tier and the PTY in the Daemon

| Field         | Value                              |
| ------------- | ---------------------------------- |
| **Status**    | `accepted`                         |
| **Type**      | `Type 2 (one-way door)`            |
| **Domain**    | `Runtime / PTY / Platform Support` |
| **Date**      | `2026-04-17`                       |
| **Author(s)** | `Claude (AI-assisted)`             |
| **Reviewers** | `Accepted 2026-04-17`              |

## Context

A session's shells — the terminals the person and the session's runs write to, where `git`, compilers, interpreters, REPLs and dev servers run — each run on a pseudoterminal (PTY) the daemon holds. PTY behavior on macOS and Linux is a well-understood, battle-tested surface — `node-pty` has powered VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code, and every other Node-based terminal-hosting product for years on those platforms.

PTY on Windows is a distinct surface. Windows 10 1809 introduced ConPTY as the modern API; prior to that, tools relied on `winpty`. `node-pty` supports ConPTY on Windows, and that support is where a cluster of known open bugs lives:

- [`openai/codex#13973`](https://github.com/openai/codex/issues/13973) — ConPTY assertion failure that kills the Node host, hit by a shipping agentic CLI.
- [`microsoft/node-pty#904`](https://github.com/microsoft/node-pty/issues/904) — `SIGABRT` on Electron exit via a `ThreadSafeFunction` race condition (OPEN).
- [`microsoft/node-pty#887`](https://github.com/microsoft/node-pty/issues/887) — ConoutConnection worker strands the Node exit path (OPEN).
- [`microsoft/node-pty#894`](https://github.com/microsoft/node-pty/issues/894) — PowerShell 7 exhibits a 3.5-second delay under `useConptyDll: true` (OPEN).
- [`microsoft/node-pty#437`](https://github.com/microsoft/node-pty/issues/437) — `ptyProcess.kill()` hangs indefinitely on Windows (confirmed on Windows 10); unaffected on Linux.
- [`microsoft/node-pty#647`](https://github.com/microsoft/node-pty/issues/647) — Spawn can lock the cwd on Windows (blocks deletion until process exit).

The Tabby terminal (Eugeny/tabby) shipped GA on `node-pty` on Windows and hit the same ConPTY assertion class as `openai/codex#13973`; the [`Eugeny/tabby#10134`](https://github.com/Eugeny/tabby/issues/10134) thread documents the user-rollback wave that followed. Tabby's closure strategy was to pin to an older `node-pty` version — a workaround, not a structural fix.

Rust alternatives exist. [`alacritty_terminal`](https://github.com/alacritty/alacritty/tree/master/alacritty_terminal)'s `tty` module is the PTY layer of the Alacritty terminal and of Zed's terminal, and [`portable-pty`](https://github.com/wezterm/wezterm/tree/main/pty) is the production PTY crate used by wezterm (which handles significantly more demanding terminal workloads than an agent driver). Both implement ConPTY without the `node-pty` bug cluster, and the daemon is itself a Rust program (`sidekicks-daemon`), so either links into it and runs in the daemon's own process.

ADR-014 places Windows in V1 implicitly (V1 ships Desktop GUI, and ADR-015 commits to Electron which ships on Windows). The question is whether Windows V1 should ship as **GA** with full quality-gate equivalence to macOS and Linux, or as **Beta** with explicit quality-level caveats, and where the PTY runs.

Under a human-implementation cost model, **Option C (Windows V1 Beta)** is the better choice (cited primary sources cataloged in §Research Conducted below), because the engineering weeks that Windows-specific PTY work takes and its ongoing maintenance are load-bearing. That cost model does not hold under AI implementation (Claude Opus 4.7 executes the plan), which collapses the engineering-week estimate by more than 70%. The decision below weighs the same trade-off under the AI-implementation cost model.

## Problem Statement

What is the V1 quality tier for Windows, and what PTY strategy meets that tier given the `node-pty` bug cluster and the Tabby-precedent risk?

### Trigger

- `openai/codex#13973` shows the ConPTY assertion class killing a shipping agentic CLI, and every shell a session opens on Windows takes the same PTY path; Windows cannot ship without addressing this.
- AI implementation of the plan changes the cost-benefit math that favors Option C under a human-implementation cost model.
- Plan-001 (session core) needs a decided PTY contract before it authors terminal-session code.

## Decision

1. **Windows V1 ships as GA**, with full quality-gate equivalence to macOS and Linux.
2. **The PTY runs inside the daemon on every operating system, through `sidekicks-terminal`.** That library crate opens each shell through `alacritty_terminal`'s `tty` module (ConPTY on Windows, the Unix PTY on macOS and Linux), with `portable-pty` the library held in reserve should `alacritty_terminal`'s binding fail (Tripwire 1), and `sidekicks-daemon` links it: no separate process, stdio protocol or published package stands between the daemon and a shell. The daemon runs its own read loop for each shell, so a terminal's read pause stops draining the PTY until it resumes.
3. **`node-pty` is not used on any operating system.** Its ConPTY faults (§Context) are the reason; `sidekicks-terminal` is the one PTY implementation everywhere, the WSL server inside a WSL 2 distribution included. A PTY that cannot be opened refuses the shell; there is no second backend to fall back to.
4. **All PTY access flows through `sidekicks-terminal`'s one interface**, with one implementation on every operating system and no platform selector; consumers never see a backend choice. The daemon's own operating-system calls around it (the Windows console helper, the Job Object, the parent-death signal, the exit watch) are `sidekicks-platforms`' code. On Windows, Ctrl+C is byte `0x03` written to the ConPTY input, and the hard stop is the daemon's `console <pid>` mode. At its start the daemon calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`, so the ConPTY it opens is the system's (`kernel32`'s `CreatePseudoConsole`), never a `conpty.dll` found beside the program or on `PATH`.
5. **Windows code-signing goes through [SignPath Foundation](https://signpath.org)'s free open-source program.** Its terms ([signpath.org/terms](https://signpath.org/terms)) admit a project with an OSI license "without commercial dual-licensing for all components", no proprietary components, active maintenance, an existing release and a published code-signing policy. "The code signing certificate is issued to SignPath Foundation", so Windows names SignPath Foundation as the publisher. It removes SmartScreen's hard block on an unsigned file and keeps the NSIS installer's one-press update. The release workflow applies for the program; if the project is not eligible, the choice goes back to the person, and the distribution plan does not change silently. OV or EV is not the lever: Microsoft's [SmartScreen reputation documentation](https://learn.microsoft.com/en-us/windows/security/threat-protection/microsoft-defender-smartscreen/smartscreen-reputation) says of the EV bypass that "this behavior no longer exists".
6. **SmartScreen reputation accrues to the signer**, so one SignPath step in the release workflow signs every Windows binary the product ships — the Electron app, `sidekicks-daemon` (which holds the PTY), `sidekicks`, the client's `.node` and `libpdfium` — under the same publisher, pooling reputation rather than splitting it. Signing custody is owned by [ADR-022](022-v1-ci-cd-and-release-automation.md) §Axis 5.
7. **Orphaned child processes are contained in two layers.**

   _Layer 1 — kernel parent-death cleanup, per OS._ Every child that must not outlive the daemon is spawned from one long-lived spawner thread, because `PR_SET_PDEATHSIG` is thread-scoped on the parent side. On Linux a child started through `Command` arms `PR_SET_PDEATHSIG` (SIGHUP) and checks `getppid()` again in its own `pre_exec`, against the reparent race. That signal covers the direct child only, so the never-leak guarantee binds to a daemon-owned cgroup-v2 scope killed through `cgroup.kill` by a survivor of the daemon, which is `sidekicks-platforms`' Linux code. On a systemd host that scope is either the daemon's own service unit or a transient scope explicitly bound to it; a bare unbound scope never satisfies never-leak, because surviving providers keep it alive. A process-group fallback is not tree containment — a descendant that calls `setsid` leaves the group — so hosts without a delegated cgroup v2 run it best-effort. A shell starts through the daemon's `shell <daemon-pid>` mode, which reads the shell's program, arguments, folder, environment and raw tail, and the fallback shell's launch, from its start confirmation, and which on Linux arms the signal and re-checks `getppid()` against the daemon's pid, and on macOS does the `getppid()` check, then waits for the daemon's confirmation that it started this process and refuses to start anything unless the parent is its own responsible process, so a shell started after the daemon died exits at once, and one started before gets the terminal's hangup. The mode then execs the shell's resolved absolute path: on Linux with `execve` (`nix::unistd::execve`), on macOS with `posix_spawn` and `POSIX_SPAWN_SETEXEC` plus the attribute that disclaims the daemon's responsibility, so the shell is its own responsible process; never `execvp`, `posix_spawnp` or `Command::exec`, because glibc's and macOS's `execvp`, like macOS's `posix_spawnp`, run a file the kernel refuses (`ENOEXEC`) through `/bin/sh`. Where the exec fails, the mode writes one line naming the shell it could not start and why, and execs the platform's default shell the same way. Killing the daemon mid-spawn 250 times left 3 programs running without a parent check and none with it, at 3.95 ms more per spawn (median); Plan-021 runs that measurement on the daemon's own spawn. On Windows, before it spawns anything the daemon joins its own kill-on-close Job Object with `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, so every shell joins it at creation, and a process meant to outlive the daemon (the shared Codex app-server) leaves it through `CREATE_BREAKAWAY_FROM_JOB`; a child started through `Command` that must die with the daemon runs in `process-wrap`'s `JobObject` under its `KillOnDrop` wrapper, which sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, breakaway cleared and the handle non-inheritable, so daemon death is the last close that reaps the tree. On macOS, the daemon reaps each child itself, and an unreaped child keeps its pid, so its exit is seen while the daemon lives with no reuse.

   _Layer 2 — daemon-side orphan registry._ Entries are persisted crash-safe by one `sidekicks-platforms` function: `File::sync_all` on the same-directory temporary file, `rename`, then `sync_all` on the opened parent folder, the last of which persists the rename's directory entry; on Windows `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`. The daemon durably writes a **spawn-intent entry** carrying a unique nonce injected into the child's environment _before_ the spawn and completes it with the child's identity after, so no child ever exists outside the registry's view: a crash before the spawn leaves an intent the sweep discards after finding no nonce-bearing process, and a crash between spawn and completion is recovered by locating same-user processes carrying the nonce. On macOS the nonce search reads a child only until it execs a code-signing-restricted program such as `/bin/zsh`, because XNU withholds that program's environment from another process. A sweep at the next daemon start reaps what Layer 1 could not.

   _Registry identity._ The persisted sweep guard is the tuple `(boot_id, pid, start_time)`. `start_time` on Linux is ticks since boot, which a reboot resets, so a bare `(pid, start_time)` pair can re-match a coincidental post-reboot process; with boot-id recorded, a mismatched boot-id proves the entry stale by construction and the sweep **discards rather than signals** — the fail-closed direction for a kill-path guard. Sources: Linux `/proc/sys/kernel/random/boot_id` with `proc_pid_stat(5)` field 22; macOS the `kern.bootsessionuuid` sysctl with `proc_pidinfo(PROC_PIDTBSDINFO)`, an absolute start instant. On Linux the pidfd is opened after the spawn with `rustix::process::pidfd_open`, which is race-free for the daemon's own unreaped child (std's `create_pidfd` is unstable), and signaling rides `pidfd_send_signal`; the sweep checks a handle it opens on a registry pid against the persisted `(boot_id, pid, start_time)` before it signals. The registry layer is **load-bearing on macOS**, which has no kernel parent-death primitive, and **defense-in-depth on cgroup-v2 Linux and Windows**.

8. **Path identity in the turn-snapshot contract is git path identity — byte equality — on every platform.** Every comparison site on the path — the capture leg's boundary subtraction, the restore leg's index pre-drop, the delete-pass exemption at its recorded kind widths, and obstruction scoring's recorded-set membership, proper-ancestor walk, and displacer keying — compares the listing's own bytes. The layer is deliberately no stronger than its substrate: git's index and trees are byte-path-keyed everywhere, and a tree carrying two fold-colliding paths checks out to a single file on a case-insensitive filesystem, which is upstream git's documented hazard. Three hazards follow, the first two requiring an actor's explicit case-divergent action mid-turn: a case-only respelling of a recorded sparse-boundary path evades the byte-exact delete exemption, so boundary-time content deletes; the same class evades obstruction scoring's byte-keyed refusal; and a snapshot tree holding two fold-colliding paths collapses to one file at restore. **Fold-aware matching is rejected**: correct folding is filesystem-private (APFS's own casefold tables and its separate Unicode-normalization insensitivity, NTFS's per-volume `$UpCase` table), so a daemon-side fold mints a third identity notion agreeing with neither git nor the filesystem; on case-sensitive filesystems distinct-case paths are genuinely distinct files and a folded exemption over-matches; and the sibling alias class, Unicode-normalization insensitivity, has identical structure, so a case-only fix is half a fix. [Spec-008 §Turn-Boundary Snapshots](../specs/008-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots) carries the capture and restore surface this rule governs.

### Thesis — Why This Option

The `node-pty` Windows bug cluster has a concrete trigger in `openai/codex#13973`, an agentic CLI crashing on it, and every shell a session opens on Windows takes that path. Shipping V1 Windows on `node-pty` puts us on the same path Tabby walked — GA on a known-fragile PTY stack, followed by a user-visible crash cluster and a reactive pin-the-dependency workaround. The Tabby precedent is the strongest evidence we have that the bug cluster is not theoretical: another production team shipped through it, and the visible failure mode was user rollback. Running the PTY inside the Rust daemon through `alacritty_terminal` side-steps the entire bug cluster, because its ConPTY binding does not share `node-pty`'s code path, and it gives one PTY implementation on every operating system. It adds no second process, no protocol between the daemon and its shells, no published package and no extra binary to sign: the PTY ships inside `sidekicks-daemon`.

The cost is that a native ConPTY crash, a fault inside ConPTY's code in the daemon's own process, takes the daemon down with every terminal it holds, where a separate PTY process would lose only its own terminals. Zed accepts the same cost and runs its PTY in-process. The distribution and signing work is the work the daemon already needs. Signing uses SignPath Foundation's open-source program on Windows — a documented path, not invent-here work.

### Antithesis — The Strongest Case Against

There are two. The industry norm is `node-pty` everywhere: VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code, and every other Electron-based terminal-hosting product ships on `node-pty` on Windows. The bug cluster is real but has been tractable in practice for other teams; the Tabby rollback wave was specifically about one class of the ConPTY assertion, and the fix (pin to an older `node-pty`) took one PR. And where a team does leave `node-pty`, process isolation is the cautious shape: VS Code runs its PTYs in a separate pty-host process and Wave in a separately compiled sidecar, so a ConPTY fault ends that process and the host survives; running ConPTY in the daemon trades that isolation away. The strongest counter-example to the chosen architecture is [Warp Terminal](https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290): Rust-native end-to-end with ~90% cross-OS code share, and yet Warp explicitly labels Windows as **Beta** rather than GA. A Rust-first team that has solved every other Rust-on-Windows surface still chose caution on Windows tier — that is signal that even the "right" PTY backend does not retire all Windows-specific risk. The V1 Beta recommendation on `node-pty` is the staff-engineer-default position: ship on the industry norm, use the Beta label to communicate known quality delta, and move the PTY only if the bug cluster actually bites.

### Synthesis — Why It Still Holds

The antithesis is the correct default position for a team that is one major bug away from capacity exhaustion. It is the wrong position for a team where AI-implementation collapses the cost half of the cost-benefit. The load-bearing fact is `openai/codex#13973`: the exact assertion class that caused the Tabby rollback is open against a shipping agentic CLI, on the PTY path every Windows shell in a session takes. "Use the industry norm" is sound advice when the industry norm works; the industry norm has a known open bug in exactly this workload, and the Tabby precedent shows what happens when you ship GA on top of it. "Ship Beta" (Option C) is the hedge move: it delays the problem without solving it, and it communicates to Windows users that the product does not take their tier seriously — a category-positioning cost for an agentic coding product that targets the developer market. A separate PTY process buys isolation at the price of a second process, a stdio protocol with its own framing, its own published packages and signing target, and a crash contract between the two; the in-daemon PTY pays instead with a daemon that a native ConPTY crash takes down. The faults in `node-pty`'s cluster sit in `node-pty`'s own binding, which `alacritty_terminal` does not share, so that crash is rare, and the desktop's daemon supervision ([Spec-021](../specs/021-desktop-app-and-renderer.md)) restarts the daemon. The chosen architecture has a shipping precedent on the axis that matters: [Zed shipped Windows GA day-one on 2025-10-15](https://zed.dev/blog/zed-for-windows-is-here) with terminal working out of the box, built on `alacritty_terminal` in its own process — direct evidence that a Rust PTY backend ships GA-clean on Windows, in-process. The structural fix beats the hedge.

## Alternatives Considered

### Option A: Windows V1 GA + PTY in the daemon (Chosen)

- **What:** Decision above.
- **Steel man:** Structural fix to the `node-pty` Windows bug cluster. Uniform V1 quality tier across Windows, macOS, Linux. One PTY implementation, in-process, on every operating system, with no second process, protocol or package. Signing pattern is documented (SignPath Foundation's open-source program).
- **Weaknesses:** A native ConPTY crash takes the daemon down with every terminal it holds; Windows signing depends on SignPath Foundation finding the project eligible.

### Option B: Windows V1 GA on `node-pty` only (Rejected)

- **What:** Ship Windows V1 GA using `node-pty` exclusively, matching the industry norm (VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code).
- **Steel man:** Industry norm; minimal implementation surface; the `node-pty` bug cluster has been tractable in practice for other teams; the fix for the Tabby ConPTY class was a single dependency pin; AI implementation makes it trivial to monitor and pin `node-pty` versions.
- **Why rejected:** `openai/codex#13973` is an open issue against the exact ConPTY assertion class that caused the Tabby user-rollback wave. Shipping GA on a PTY stack with a known open bug trigger is path-dependent on a future upstream fix that is not committed. "Pin an older version" is a workaround, not a fix; it constrains future `node-pty` upgrades and keeps us on code that does not receive further maintenance. The Tabby precedent shows the user-visible failure mode; accepting that risk for V1 launch is not consistent with a GA tier for Windows.

### Option C: Windows V1 Beta on `node-pty` (Rejected)

- **What:** Ship V1 with a Windows tier explicitly labeled Beta. Quality gates tolerate known `node-pty` issues.
- **Steel man:** Lowers V1 scope; communicates quality delta honestly to Windows users; gives a production-data escape hatch for the PTY decision; matches the cost-benefit under a human-implementation cost model.
- **Why rejected:** Under a human-implementation cost model, Option C is driven by the engineering weeks of Windows PTY work and its ongoing cost. Under AI implementation (Claude Opus 4.7), that cost compresses by >70%. With the dominant cost collapsed, the cost-benefit inverts against the Tabby-precedent risk. Additionally, Windows Beta communicates a category-positioning cost: a developer-market product that ships one of its three target platforms at a lower tier is read as "don't use this on Windows," which loses users rather than setting expectations. The Beta hedge also does not structurally address the `node-pty` bug cluster; it only labels the risk.

### Option D: The newer bundled ConPTY DLL (Deferred, not rejected)

- **What:** Load the newer `conpty.dll` that ships apart from Windows (the one `node-pty`'s `useConptyDll: true` option bundles) by full path, rather than the system's ConPTY. Some of the bug cluster is reported fixed in the bundled DLL.
- **Steel man:** A forward fix within ConPTY itself, aligned with the upstream maintenance direction.
- **Disposition:** Deferred, not rejected. While `microsoft/node-pty#894` (PowerShell 7 3.5-second delay under the bundled DLL) stays open, loading it creates a new regression class, so the daemon loads ConPTY from System32 only (Decision item 4). Once `#894` closes, the bundled DLL is what Tripwire 3 below evaluates.

### Option E: Windows V1 GA + a Rust PTY sidecar process (Rejected)

- **What:** Run the PTY in a separate Rust program the daemon spawns, speaking a stdio protocol with its own framing, published as one signed binary per Windows architecture.
- **Steel man:** A native ConPTY crash ends only the sidecar and its terminals; the daemon and every session survive, as VS Code's pty host and Wave's sidecar show.
- **Why rejected:** It costs a second process and a protocol between the daemon and its shells, with its own framing, its own packages and signing target, and a crash contract to keep in step with the daemon. The daemon is itself a Rust program, so the same PTY library runs in-process at none of those costs; the price the in-daemon PTY pays, a daemon that a native ConPTY crash takes down, is the smaller one.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `alacritty_terminal` does not share `node-pty`'s ConPTY bug cluster. | `alacritty_terminal`'s `tty` module is a separate Rust binding of the ConPTY API, shipped by Alacritty and by Zed's terminal on Windows; no open-issue pattern matching the `node-pty` cluster. | Windows shells fail until a fixed release ships; `portable-pty`, the library held in reserve, is evaluated per Tripwire 1. |
| 2 | AI implementation materially compresses the engineering-week estimate for the Windows PTY work. | Comparable implementation tasks under AI execution have shown > 70% cycle-time compression; `alacritty_terminal` is a stable external dependency. | Windows PTY delivery slips V1. |
| 3 | The project meets SignPath Foundation's open-source terms. | Apache-2.0 is OSI-approved and the project has no commercial dual license; [signpath.org/terms](https://signpath.org/terms) also asks for no proprietary components, active maintenance, an existing release and a published code-signing policy, which the release workflow publishes. | The choice goes back to the person with the remaining paths (the Microsoft Store, a bought certificate, or unsigned with SmartScreen's block at install); the distribution plan does not change silently. |
| 4 | A native ConPTY crash inside the daemon is rare enough that losing the daemon with it is an acceptable failure. | Zed and Alacritty run ConPTY in their own process on Windows; the faults in `node-pty`'s cluster sit in `node-pty`'s own binding. | Every Windows session loses its terminals at each crash; the PTY moves behind a process boundary as a mode of `sidekicks-daemon`, which needs no package of its own. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Bug traceable to `alacritty_terminal`'s ConPTY binding | Low | High | Local crash reports; structured-log correlation | Fixed daemon in the next release; upstream bug report to Alacritty; `portable-pty` evaluated per Tripwire 1 |
| A native ConPTY crash takes the daemon down | Low | High | The daemon's crash report (the `minidump` mode's minidump) | The desktop's daemon supervision restarts the daemon, and every terminal it held ends; Tripwire 1 if it recurs |
| A `conpty.dll` beside the program or on `PATH` would be loaded in place of the system's | Low | High | A Windows-leg test that plants a dummy `conpty.dll` beside the program and on `PATH` and checks that the loaded ConPTY is null or under System32 | `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` at the daemon's start (Decision item 4), and every library the daemon loads at run time loads from System32 or by full path |
| SignPath Foundation finds the project ineligible | Low | Med | SignPath's answer to the release workflow's application | The choice goes back to the person; the distribution plan does not change silently |
| Windows build regression (Rust toolchain or `alacritty_terminal` build break) | Low | Med | CI build for both Windows targets | Revert to last-known-good crate version; file upstream issue |
| AV/EDR false-positive on `sidekicks-daemon` or its spawn pattern (e.g., SentinelOne flagging Electron stack per [`microsoft/vscode#239184`](https://github.com/microsoft/vscode/issues/239184); Windows Defender flagging detached PTY spawn + liveness-poll as `Trojan:Win32/SuspExec.SE` per the [`microsoft/node-pty#887`](https://github.com/microsoft/node-pty/issues/887) comment thread) | Med | High | AV blocks seen on the person's machine (local crash reports, the daemon log); signing-pipeline pre-publish AV scan | `sidekicks-daemon` signed under the same identity as the Electron app (SmartScreen reputation pooling per Decision item 6); pre-launch submission to major AV vendors (Microsoft Defender, SentinelOne, CrowdStrike) for whitelist; documented expected-AV-warning UX page; daemon liveness poll cadence kept above C2-beacon thresholds where avoidable |

## Reversibility Assessment

- **Reversal cost:** Medium once V1 ships. Moving the PTY out of the daemon means running `sidekicks-terminal` in a helper mode of `sidekicks-daemon` behind the frame codec, with a crash contract between the two; the program and its signing stay one. No user-data migration.
- **Blast radius:** `crates/sidekicks-terminal`, `sidekicks-platforms`' Windows code, the daemon's shell supervision, the Windows signing pipeline, the Windows CI build.
- **Migration path:** Put the same `sidekicks-terminal` interface behind a daemon mode, run the Windows shell suite through it, and ship it in one release.
- **Point of no return:** First V1 Windows ship. Before that, reversal is implementation-cost only.

## Consequences

### Positive

- Windows V1 ships at GA tier with the same quality gates as macOS and Linux.
- `node-pty` bug cluster (including `openai/codex#13973`) is structurally addressed on Windows rather than deferred.
- One PTY implementation, in-process, on every operating system, with no second process, protocol, package or crash contract.
- `sidekicks-terminal`'s one interface hides the platform's PTY from consumers; a later backend swap (`portable-pty`) stays behind it.
- SmartScreen reputation pools across the Electron app, `sidekicks-daemon`, `sidekicks`, the client's `.node` and `libpdfium` (shared identity).

### Negative (accepted trade-offs)

- A native ConPTY crash takes the daemon down with every terminal it holds.
- Windows CI build infrastructure required for both Windows targets.

### Unknowns

- Actual shell spawn latency in production workloads; measured once by Plan-021's Test B1 on `windows-latest`.
- SignPath Foundation's eligibility answer; known once the release workflow applies.

## Decision Validation

### Success Criteria

Both rows are items of Plan-021's Done Checklist. Row 1 is Plan-021's Test M1, run as an ordinary CI job; row 2 is Plan-021's Test B1, measured once on `windows-latest`. Both measure the daemon's in-process ConPTY.

| Metric | Target | Measurement Method |
| --- | --- | --- |
| Windows shell end-to-end pass-rate through the daemon's in-process ConPTY (a shell spawned, written to, read back, resized, killed and its exit code delivered) | Passes on every CI run | `windows-latest` CI job |
| Shell spawn latency p95 | ≤ 50 ms | Measured once by Plan-021's Test B1 |

### Tripwires (Revisit Triggers)

1. **A bug traceable to `alacritty_terminal`'s ConPTY binding, or native ConPTY crashes that recur.** — Evaluate `portable-pty` behind the same `sidekicks-terminal` interface, and whether the PTY moves behind a process boundary as a daemon mode.
2. **SignPath Foundation finds the project ineligible, or withdraws it.** — The choice goes back to the person with the remaining paths (the Microsoft Store, a bought certificate, or unsigned with SmartScreen's block at install); nothing changes in the release workflow until they choose.
3. **`microsoft/node-pty#894` closes and a fault the system's ConPTY shows is fixed in the bundled `conpty.dll`.** — Evaluate loading the bundled DLL by full path (Option D), run the Windows shell suite against it, and keep System32's ConPTY until it passes.
4. **A field report of turn-snapshot data loss traceable to filesystem name-aliasing (case-folding or Unicode normalization) on any V1 platform.** — Promote a capture-time collision diagnostic — detect fold-colliding pairs within the snapshot's recorded sets, the snapshot tree and the sparse boundary set, and enumerate them on the capture diagnostic channel, contract unchanged — as the first response. Any change to the byte-exact matching semantics of §Decision item 8 belongs to [Spec-008 §Turn-Boundary Snapshots](../specs/008-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots), not this ADR.

## References

### Research Conducted

**Orphan-containment sources (§Decision item 7):**

- [prctl(2)](https://man7.org/linux/man-pages/man2/prctl.2.html) — `PR_SET_PDEATHSIG` caveats (the death signal is cleared for the child of a `fork(2)`, **preserved across normal `execve(2)`**, cleared on set-user-ID / set-group-ID / capability-carrying execs and on credential changes, and thread-scoped on the parent side) grounding the arm-per-child + `getppid()` reparent-race re-check
- [cgroup-v2 kernel documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html) — `cgroup.kill` tree-kill where available
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` last-handle-close semantics + breakaway flags
- [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html) — the directory-entry caveat (a file fsync does not persist the rename's directory entry) behind the parent-dir fsync step
- [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information) — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every process in the job when the last handle to the job is closed
- [Destroying all child processes (and grandchildren) when the parent exits](https://devblogs.microsoft.com/oldnewthing/?p=2433) — a kill-on-close job object as the way to end a parent's whole tree when the parent exits
- [PostgreSQL patch: Use Windows Job Objects to prevent orphaned child processes](https://www.postgresql.org/message-id/attachment/184076/v2-0001-Use-Windows-Job-Objects-to-prevent-orphaned-child.patch) — a peer putting its children in a kill-on-close job object so they die with the postmaster, because Windows has no `getppid()` orphan check
- [PR_SET_PDEATHSIG(2const)](https://man7.org/linux/man-pages/man2/pr_set_pdeathsig.2const.html) — no parent-death signal is sent when the parent is already gone at the `prctl` call, so `getppid()` is checked after it
- [XNU `sysctl_procargsx` in `bsd/kern/kern_sysctl.c` (`xnu-12377.121.6`)](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/kern/kern_sysctl.c) — `KERN_PROCARGS2` omits a process's environment when the reader is another process and the target is `cs_restricted`, unless System Integrity Protection is off or the reader is entitled; behind the finding that a restricted program's environment is withheld from the nonce search
- [node-pty `src/unix/spawn-helper.cc` (`v1.2.0-beta.15`)](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.15/src/unix/spawn-helper.cc) — on macOS the helper opens the terminal to make it the controlling terminal and only then `execvp`s the program, so the parent check runs with the terminal already taken; on Linux, [`src/unix/pty.cc`](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.15/src/unix/pty.cc) starts the child through `forkpty(3)`, which takes the terminal before the exec
- [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html) — StartLimit defaults (the crash-budget precedent — 5 starts / 10 s — the 5/60 s budget parallels) and `BindsTo=` + `After=` stop-propagation ("the unit bound to strictly has to be in active state for this unit to also be in active state"); [systemd.kill(5)](https://man7.org/linux/man-pages/man5/systemd.kill.5.html) — `KillMode=control-group` ("all remaining processes in the control group of this unit will be killed on unit stop"; the default); [systemd.scope(5)](https://man7.org/linux/man-pages/man5/systemd.scope.5.html) — scope lifecycle binds to "the existence of at least one process in the scope", not to any one process (all three fetched 2026-07-03; they ground the decision row's daemon-lifecycle-binding requirement)

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `openai/codex#13973` | Upstream issue | ConPTY assertion (`remove_pty_baton(baton->id)` in `conpty.cc`) hit by a shipping agentic CLI | <https://github.com/openai/codex/issues/13973> |
| `microsoft/node-pty#904` | Upstream issue | `SIGABRT` on Electron exit; ThreadSafeFunction cleanup race; same class as `codex#13973` | <https://github.com/microsoft/node-pty/issues/904> |
| `microsoft/node-pty#887` | Upstream issue | ConoutConnection worker thread strands Node exit after `kill()` | <https://github.com/microsoft/node-pty/issues/887> |
| `microsoft/node-pty#894` | Upstream issue | PowerShell 7 3.5 s output delay under `useConptyDll: true`; blocks the bundled-ConPTY workaround | <https://github.com/microsoft/node-pty/issues/894> |
| `microsoft/node-pty#827` | Upstream issue | Windows crash on Node.js v22 — "Cannot resize a pty that has already exited"; thrown error → process exit; Gemini CLI users hit in production | <https://github.com/microsoft/node-pty/issues/827> |
| `microsoft/node-pty#437` | Upstream issue | `ptyProcess.kill()` hangs on Windows, works on Linux; process-tree kill not reliable | <https://github.com/microsoft/node-pty/issues/437> |
| `microsoft/node-pty#647` | Upstream issue | Spawn locks cwd on Windows (blocks worktree workflows) | <https://github.com/microsoft/node-pty/issues/647> |
| `microsoft/node-pty#167` | Upstream issue | Sending a signal to all processes in the processgroup of the pts; Ctrl+C / SIGINT propagation does not reach process group on Windows | <https://github.com/microsoft/node-pty/issues/167> |
| `microsoft/node-pty#842` | Upstream issue | Removed winpty support; ConPTY (Windows 10 1809+) is the only supported backend (telemetry: <0.1% pre-ConPTY) | <https://github.com/microsoft/node-pty/issues/842> |
| `microsoft/node-pty` releases | Documentation | The 1.2.0 line (`v1.2.0-beta.12`, 2026-03-12) bundles conpty `1.25.260303002` and adds the `useConptyDll` option; Tripwire 3 waits on a stable 1.2.0 | <https://github.com/microsoft/node-pty/releases> |
| `Eugeny/tabby#10134` | Upstream issue (precedent) | Tabby GA on `node-pty` → user-rollback wave on ConPTY assertion class; closed by pinning `node-pty` | <https://github.com/Eugeny/tabby/issues/10134> |
| `microsoft/vscode#224488` | Upstream issue | "Ship newer version of conpty" — VS Code's stalled ask; "fixes in ConPTY can take 1–2 years to make it to users" | <https://github.com/microsoft/vscode/issues/224488> |
| `microsoft/vscode#245709` | Upstream issue | ConPTY assertion failure on new window in VS Code — same assertion class as `codex#13973` | <https://github.com/microsoft/vscode/issues/245709> |
| `microsoft/vscode#252489` | Upstream issue | "Terminal commands are not reliable when conpty dll is false" — corroborates `useConptyDll: true` is the forward direction (supports Option D deferral) | <https://github.com/microsoft/vscode/issues/252489> |
| `microsoft/vscode#239184` | Upstream issue | SentinelOne EDR detected Electron stack as a security threat (live AV/EDR pattern) | <https://github.com/microsoft/vscode/issues/239184> |
| `microsoft/vscode#255285` | Upstream issue | Terminal viewport shifts left with Chinese IME in `gemini cli` on Windows ConPTY (Unicode/IME edge case in agentic CLI under ConPTY) | <https://github.com/microsoft/vscode/issues/255285> |
| `nodejs/node#62125` | Upstream issue | Windows detached-spawn silent termination on Node 24.13; cross-referenced from `node-pty#887`; Node.js Windows regressions cross-pollinate | <https://github.com/nodejs/node/issues/62125> |
| `wezterm/portable-pty` source tree | Reference implementation | Production Rust PTY crate used by wezterm; cross-platform ConPTY on Windows | <https://github.com/wezterm/wezterm/tree/main/pty> |
| `portable-pty` docs.rs listing | Documentation (crate listing) | Latest crate API docs; mature; used outside wezterm in Tauri terminal apps | <https://docs.rs/portable-pty/latest/portable_pty/> |
| Zed — "Windows When? Windows Now" blog | Engineering blog | Zed shipped Windows GA day-one on 2025-10-15 with terminal working; uses `alacritty_terminal` (Rust PTY, not `node-pty`) — primary precedent for "Rust PTY is reliable on Windows" | <https://zed.dev/blog/zed-for-windows-is-here> |
| Zed terminal core docs (DeepWiki, third-party mirror) | Documentation (third-party mirror) | Zed terminal architecture: Rust-native PTY via `alacritty_terminal`; flagged as third-party DeepWiki mirror, not upstream zed-industries source | <https://deepwiki.com/zed-industries/zed/9.1-terminal-core> |
| Warp — "Warp Terminal is now on Windows" (Rust forum announcement) | Vendor announcement | Rust-native terminal explicitly labeled Windows BETA — Warp chose Beta despite being Rust-native; counter-example to the chosen architecture | <https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290> |
| `wavetermdev/waveterm` | Reference implementation | Wave Terminal: Electron + Go (`aymanbagabas/go-pty`) sidecar pattern; closest peer for Electron-plus-PTY-sidecar IPC topology (Go, not Rust) | <https://github.com/wavetermdev/waveterm> |
| `aymanbagabas/go-pty` | Reference implementation | Cross-platform Go PTY library; ConPTY on Windows; used in Wave Terminal | <https://github.com/aymanbagabas/go-pty> |
| `anthropics/claude-code` | Reference implementation | First-party agentic CLI shipping Windows GA on JS PTY stack via Git Bash + node-pty (industry-norm peer set anchor) | <https://github.com/anthropics/claude-code> |
| `@homebridge/node-pty-prebuilt-multiarch` | Fork repo | Parallel `node-pty` fork with prebuilt binaries (ia32/amd64/arm/aarch64); cited in Codex/Gemini CLI stack traces (signal that ecosystem has drifted to forks) | <https://github.com/homebridge/node-pty-prebuilt-multiarch> |
| Tauri v2 sidecar docs | Documentation | Sidecar spawn + lifecycle patterns (pattern-informative, Tauri-specific) | <https://v2.tauri.app/develop/sidecar/> |
| `@esbuild/*` npm packages | Distribution precedent | Platform-specific binary distribution via `optionalDependencies` + `os`/`cpu` filters | <https://www.npmjs.com/package/esbuild> |
| SignPath Foundation terms | Documentation | Free code signing for open-source projects: OSI license "without commercial dual-licensing for all components", no proprietary components, actively maintained, already released, a published code-signing policy; "The code signing certificate is issued to SignPath Foundation" | <https://signpath.org/terms> |
| Electron code-signing tutorial | Documentation | Canonical Electron code-signing reference | <https://www.electronjs.org/docs/latest/tutorial/code-signing> |
| Security Boulevard 2025-12 — "How to sign a Windows app with electron-builder" | Engineering blog | SmartScreen reputation context (signer pooling) | <https://securityboulevard.com/2025/12/how-to-sign-a-windows-app-with-electron-builder/> |
| GitHub Actions runner pricing | Documentation | Per-minute cost: Linux $0.006, Windows $0.010 (post-2026-01-01 reduction; effective ~1.67× multiplier); supports cross-compile CI cost framing | <https://docs.github.com/en/billing/reference/actions-runner-pricing> |
| VS Code `terminalProcessManager.ts` `_onExit(-1)` | Reference implementation | VS Code's `onPtyHostRestart` handler fires `this._onExit(-1)` for feature terminals when out-of-process pty-host restarts without reconnection — same architectural shape (Electron renderer consumer + single-number `exitCode` contract + out-of-process PTY host) | <https://github.com/microsoft/vscode/blob/efa934524840ee3069b83dae36afc2c855faf8b1/src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts> |
| VS Code `IPtyService.onProcessExit` payload type | Reference implementation | The "`undefined` in second slot = no observation" convention paired with the `-1` sentinel: payload typed `{ id: number; event: number \| undefined }` | <https://github.com/microsoft/vscode/blob/efa934524840ee3069b83dae36afc2c855faf8b1/src/vs/platform/terminal/common/terminal.ts> |
| `microsoft/vscode#186031` | Upstream issue | Empirical: when ptyHost dies OS-side, native Node `child_process` shape is `(code: null, signal: SIGABRT)` — the `null` exit code is what `-1` synthesizes for the IPC contract's `number` slot | <https://github.com/microsoft/vscode/issues/186031> |
| Node.js `child_process` `'exit'` event | Documentation | Substrate semantics: `code: null` on signal-kill, `signal: null` on normal exit, exactly one always non-`null`; `'exit'` does NOT fire on spawn failure (`'error'` fires instead) | <https://nodejs.org/docs/latest-v26.x/api/child_process.html#event-exit> |
| GNU Bash manual §3.7.5 "Exit Status" | Documentation | "When a command terminates on a fatal signal whose number is N, Bash uses the value 128+N as the exit status" — a `128+N` exit status asserts a signal observation | <https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html> |
| `portable-pty` `ExitStatus` | Documentation | Rust ecosystem PTY exit-status shape: `code: u32, signal: Option<String>`; `with_signal()` hard-codes `code: 1`; **no representation for host-crash with orphaned children** | <https://docs.rs/portable-pty/latest/portable_pty/struct.ExitStatus.html> |
| systemd `pidref.h` | OS source | `PidRef` struct pairs pid + pidfd (+ a pidfs inode id on kernels ≥ 6.9): the PID-reuse-safe process-reference precedent | <https://github.com/systemd/systemd/blob/main/src/basic/pidref.h> |
| pidfd_open(2) | Kernel man page | Stable process handle; `pidfd_send_signal` never signals a recycled PID; post-spawn `pidfd_open` is guaranteed un-recycled ONLY while SIGCHLD is not `SIG_IGN`, `SA_NOCLDWAIT` is unset, and the zombie is unreaped — else create the child with `CLONE_PIDFD` | <https://man7.org/linux/man-pages/man2/pidfd_open.2.html> |
| proc_pid_stat(5) | Kernel man page | `starttime` field 22 is ticks since boot — why the bare `(pid, start_time)` pair needs boot-id across reboots | <https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html> |
| sd_id128_get_boot(3) | systemd man page | Boot ID read from `/proc/sys/kernel/random/boot_id` — "randomly generated early at boot and is unique for every running kernel instance": the Linux boot-id source | <https://man7.org/linux/man-pages/man3/sd_id128_get_boot.3.html> |
| LWN race-free-signaling pair | Article pair | The PID-reuse signal race pidfd closes | <https://lwn.net/Articles/773459/> + <https://lwn.net/Articles/784989/> |
| xnu `proc_info.h` | OS source | `struct proc_bsdinfo` `pbi_start_tvsec`/`pbi_start_tvusec` via `PROC_PIDTBSDINFO`: the macOS absolute process-start instant | <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h> |
| xnu `kern_sysctl.c` | OS source | `bootsessionuuid_string` exposed as the `kern.bootsessionuuid` sysctl: a fresh boot-session UUID per boot — the macOS boot-id source | <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c> |
| Rust `std::process::ExitStatus` | Documentation | Substrate semantics: `code()` returns `Option<i32>` and is `None` when killed by signal on Unix — canonical "absence-of-observation" representation | <https://doc.rust-lang.org/stable/std/process/struct.ExitStatus.html> |

### Related ADRs

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — the daemon's wire; the PTY needs no wire of its own, since it runs inside the daemon.
- [ADR-014: V1 Feature Scope Definition](./014-v1-feature-scope-definition.md) — places Desktop GUI in V1 (which implies Windows shipment via ADR-015 Electron on Windows).
- [ADR-015: Electron Desktop App](./015-electron-desktop-app.md) — commits to Electron on all three platforms; `sidekicks-daemon` signs under the same identity as the Electron app to pool SmartScreen reputation.
- [ADR-010: Tokens, Passkeys And The Remote Channel](./010-tokens-passkeys-and-the-remote-channel.md) — the service's tokens and its remote channel are the same on every platform, which frames the Windows GA expectation symmetrically.

### Related Docs

- [V1 Feature Scope](../architecture/v1-feature-scope.md) — the Windows-tier row cites this ADR.
- [Daemon Architecture](../architecture/daemon.md) — the PTY inside the daemon.
- [Deployment Topology §Container and Packaging](../architecture/deployment-topology.md#container-and-packaging) — binary distribution surface.
- [Plan-021: Terminal](../plans/021-terminal.md) — builds `sidekicks-terminal` and the Windows shell suite this ADR's success criteria name.
- `crates/sidekicks-terminal` — the PTY's one interface (§Decision items 2 and 4); `crates/sidekicks-platforms` — the orphan containment of §Decision item 7.
