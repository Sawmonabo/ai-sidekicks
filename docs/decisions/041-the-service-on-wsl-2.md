# ADR-041: The Service On WSL 2

| Field         | Value                                          |
| ------------- | ---------------------------------------------- |
| **Status**    | `accepted`                                     |
| **Type**      | `Type 1 (two-way door)`                        |
| **Domain**    | Daemon, Local IPC, Windows, Credential Custody |
| **Date**      | 2026-09-26                                     |
| **Author(s)** | Claude (AI-assisted)                           |
| **Reviewers** | Sawmon Abo                                     |

---

## Context

On a Windows computer a person may keep Claude Code and Codex inside a WSL 2 distribution, such as Ubuntu, rather than on Windows. Both providers support it: Claude Code documents its desktop app running a session inside the distribution, and Codex documents WSL as a supported place to run. A person who works that way expects the product to work there too.

The background service is the person's own long-running process: it starts providers, holds their sessions, runs terminals and workflows, and outlives the desktop app ([Spec-006 §Required Behavior](../specs/006-local-ipc-and-daemon-control.md#required-behavior)). A daemon running on Windows cannot run a provider installed inside a distribution as the provider expects, and a daemon and sessions on different sides cannot see each other's inboxes or session registries. Its local clients — the desktop app's main process and the CLI — reach it over an OS-local transport, a named pipe on Windows ([ADR-008](./008-default-transports-and-relay-boundaries.md)), with loopback rejected as a weaker local boundary. A computer is one machine to the person's other devices: it is listed once and has one identity key ([Spec-028](../specs/028-remote-control.md)).

WSL imposes its own rules. A distribution's instance ends when its last client closes, after `instanceIdleTimeout` (15 seconds by default) and the virtual machine after `vmIdleTimeout` (60 seconds, Windows 11 only); systemd services inside it do not keep it alive; an instance ends with the Windows session that created it; and WSL cannot run as LocalSystem. A killed `wsl.exe` closes its program's standard streams and sends it no signal. After a sleep, a new `wsl.exe` can hang until a reboot while running ones keep working. Several jobs the service owes while the app is quit are Windows-only: keeping the machine awake, waking it for a reset, posting and withdrawing banners, scanning incoming files with the machine's antivirus, and custody in Credential Manager. None of them can be done from a Linux process.

## Problem Statement

Where does the background service run on a Windows computer whose providers live in a WSL 2 distribution, how do Windows clients reach it, and what on Windows keeps it alive and does its Windows-only jobs?

### Trigger

WSL 2 is a first-class place to run Claude Code and Codex, including keeping the service running while signed out where Windows allows it, carrying a dev server's port when WSL cannot, and moving each account's sign-in with the service. The service's install, start, pipe and custody on Windows each depend on this answer.

---

## Decision

We will run one background service per Windows computer, on the side where Claude Code and Codex are installed — Windows or one WSL 2 distribution — and inside a distribution it will be the daemon plus the service's Windows half, a small native Windows program started by a per-user logon task, which holds one attached `wsl.exe` running the daemon, serves the one per-user named pipe by carrying each client as a stream on one HTTP/2 channel over that `wsl.exe`'s standard input and output, is the Windows arm of key custody, and does every Windows-only job; on native Windows the same program runs as the daemon's child, so each of those jobs has one implementation.

### Thesis — Why This Option

- **One service on the providers' side.** The providers run where they are installed, with the paths, sandbox and hooks their own documentation describes. One service keeps the computer one machine, with one identity key and one registration, which is what linked devices and the relay assume.
- **Something on Windows must hold WSL open.** Microsoft states that systemd services do not keep a WSL instance alive, and the last client gone ends the instance. One attached `wsl.exe`, held for the service's whole life by a Windows process, keeps the distribution and the virtual machine running without editing the person's `.wslconfig`. Task Scheduler, not the app, is that process's parent, so a quit leaves the service running as it does everywhere else.
- **One pipe, one transport, on both kinds of Windows computer.** Windows clients open the same `\\.\pipe\ai-sidekicks-<user SID>` whichever side runs the service, so a client never needs to know the side. ADR-008's OS-local default and its rejection of loopback hold unchanged; nothing listens on a port for the service's clients. The pipe fails closed: the server rejects remote clients, grants the person alone and refuses to serve when another program holds its name; the client opens at identification level and checks the pipe's owner before writing a byte.
- **One channel, not a link per connection.** Every client is one stream on one HTTP/2 connection over the `wsl.exe` the Windows half already holds, so a new client costs no process and cannot hit the hang a new `wsl.exe` can meet after a sleep. HTTP/2 brings multiplexing, flow control and backpressure from maintained implementations — Node's own `http2.performServerHandshake` and the `h2` crate — rather than a framing of our own. Measured over a real child's standard streams: 50 MB up in 148 ms and 20 concurrent 1 MB downloads in 81 ms; a 50 MB echo fails at Node's default session memory and passes at 128 MB, which the channel sets.
- **One implementation per Windows job.** The Windows half does custody, keep-awake, the wake timer, banner withdrawal and the antivirus scan on a WSL computer, and the same binary does them as the daemon's child on native Windows. It also serves the native daemon's pipe, because libuv's pipe server creates its pipe with a null security descriptor and without refusing remote clients.
- **No Windows path crosses for a dropped file.** Files dropped on the composer are staged to the daemon as bytes ([Spec-012 §Ingest Validation And Payload Bounds (V1)](../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1)), so no path crosses.
- **Custody stays on Windows for both sides**: the daemon inside the distribution keeps its secrets in Windows' Credential Manager through the Windows half, so a Windows computer has one place for secrets on either side, the machine's identity and the store are the same on either side, and a move between sides is not a move between machines.

---

## Alternatives Considered

### Option A: The providers' side, with the Windows half and one channel over `wsl.exe` (Chosen)

- **What:** One service per computer on the providers' side; on WSL, the daemon in the distribution plus the Windows half on Windows, a per-user logon task, one attached `wsl.exe`, one per-user named pipe served by the Windows half, and one HTTP/2 channel over that `wsl.exe`'s standard input and output.
- **Steel man:** It keeps every existing local-transport rule, adds no listening port, survives a `wsl.exe` hang after sleep for every connection already open, gives each Windows job one implementation on both kinds of Windows computer, and keeps the computer one machine.
- **Weaknesses:** It adds a Rust program to build, sign and ship for x64 and arm64. It adds a hop to every local call on a WSL computer, and on native Windows one small child process, whose cost is measured before build. It rests on `wsl.exe`'s standard streams carrying binary intact, which a probe checks before build. The WSL virtual machine stays up for the service's whole life, a cost the person pays for running their providers in WSL and which is measured and stated.

### Option B: Loopback forwarding, with a standard-streams fallback (Rejected)

- **What:** The daemon listens on `127.0.0.1` inside the distribution, WSL's localhost forwarding carries it to Windows, and clients fall back to `wsl.exe` standard streams where forwarding is off.
- **Steel man:** No Windows program is needed for transport, and WSL already forwards loopback ports in its default networking mode.
- **Why rejected:** It is two exceptions to the OS-local rule in Spec-006 and Spec-021 and brings back the loopback boundary ADR-008 rejected. A Windows program already on the port breaks the forward, the forward relays only in the listener's own address family, and it still needs a Windows process to hold WSL open and do the Windows jobs.
- **What would change the answer:** WSL gaining a first-class, per-user, access-controlled local socket that Windows clients can open directly.

### Option C: A `wsl.exe` per connection (Rejected)

- **What:** Each client connection starts its own `wsl.exe` running a small relay to the daemon's Unix socket, as several editors' WSL modes do.
- **Steel man:** Simple, no multiplexer, each connection isolated; proven in widely used editors.
- **Why rejected:** A process pair per connection, and after a sleep every new `wsl.exe` can hang until a reboot while running ones keep working, so every new connection would hang.
- **What would change the answer:** WSL fixing the post-sleep hang, together with the channel probe finding one link per connection cheap enough.

### Option D: One `wsl.exe` link process per pipe client (Rejected)

- **What:** The Windows half serves the pipe but starts one `wsl.exe` link for each pipe client instead of multiplexing them over one.
- **Steel man:** Simpler than a multiplexer; each client's bytes run on their own link.
- **Why rejected:** It has Option C's per-connection cost and the same post-sleep hang for every new client.
- **What would change the answer:** As Option C.

### Option E: One service per side (Rejected)

- **What:** A service on Windows and another inside each distribution the providers use, each with its own store.
- **Steel man:** No move is ever needed; each side runs its own providers natively.
- **Why rejected:** Two identities for one computer, against the one machine linked devices and the relay see; two stores the person must keep in step; and a daemon on one side cannot see sessions on the other.
- **What would change the answer:** The product letting one computer present as several machines, which it does not.

### Option F: No Windows program (Rejected)

- **What:** Everything inside the distribution, with the app's main process holding WSL open while it runs and doing the Windows jobs itself.
- **Steel man:** One less binary; the daemon is identical to a Linux machine's.
- **Why rejected:** A quit would end WSL and the service with it, breaking the rule that a quit leaves the service running; keep-awake, the wake timer and banners owed while the app is quit need a live Windows process; and a Linux process cannot reach Credential Manager.
- **What would change the answer:** WSL keeping an instance alive on its own for a service inside it, with a supported way for a Linux process to reach those Windows facilities.

### Option G: Run the Windows copy of a provider from inside the distribution (Rejected)

- **What:** Keep the service on Windows and run a Windows-installed provider against the person's WSL files.
- **Steel man:** One service everywhere on Windows, no WSL runtime.
- **Why rejected:** It is a second way of running a provider, with paths, the sandbox and hooks untested, and it is not the provider the person installed.
- **What would change the answer:** A provider documenting that mode as supported.

---

## Reversibility Assessment

- **Reversal cost:** Days. The Windows half's transport role sits behind the one pipe name and the client SDK's pipe client; replacing the channel changes the Windows half and the daemon's channel end, not the clients.
- **Blast radius:** The service's install, start and stop on Windows, the Windows pipe, custody's Windows arm, and the Windows-only jobs. Settings › Providers is the only screen that names the side.
- **Migration path:** Replace the channel with another carrier between the same two ends; the stores, custody and pipe name are unchanged.
- **Point of no return:** None for the transport. The one lasting commitment is custody on Windows for both sides, which a later design would keep.

## Consequences

### Positive

- The providers run where the person installed them, with nothing to reinstall.
- The computer stays one machine: a move between sides keeps the key, the registration and every link.
- Local clients keep one transport and one pipe name on every Windows computer, with no listening port.
- Every Windows-only job has one implementation.

### Negative (accepted trade-offs)

- One more signed native binary in the release, x64 and arm64.
- One more hop for local calls on a WSL computer, and one small child process on native Windows.
- The WSL virtual machine stays up while the service runs; its idle cost is measured and stated in [deployment-topology](../architecture/deployment-topology.md#local-daemon-memory-instrumentation-and-budget-triggers), and Runtime's figure counts only the service's own processes.
- A WSL service stops when the person signs out of Windows unless the signed-out task works on this machine; where it does not, the product says so and names the Windows route.

### Unknowns

- Whether a task set to run while the person is signed out holds WSL, custody, the pipe, keep-awake and the wake timer with no one signed in. Measured before build; it decides whether `--while-signed-out` ships on a WSL computer.
- The Windows half's idle working set, `wsl.exe`'s resident memory, the channel's latency and throughput against a native pipe, and the virtual machine's idle cost. Measured before build against [Plan-006 §Phase R4](../plans/006-local-ipc-and-daemon-control.md#phase-r4--the-service-on-wsl-2)'s budgets.
- Whether `wsl.exe`'s standard streams carry 1 GB of random bytes intact both ways from a program with no console. If not, this design does not hold.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| WSL basic commands | Documentation | `--exec` runs without the default Linux shell; `--shutdown` stops every distribution and the VM; `--unregister` loses all data; `Sysnative` for a 32-bit caller | https://learn.microsoft.com/en-us/windows/wsl/basic-commands |
| WSL configuration | Documentation | `instanceIdleTimeout` 15000, `vmIdleTimeout` 60000 on Windows 11 only; the memory cap and `autoMemoryReclaim` | https://learn.microsoft.com/en-us/windows/wsl/wsl-config |
| WSL and systemd | Documentation | systemd services do not keep a WSL instance alive | https://learn.microsoft.com/en-us/windows/wsl/systemd |
| WSL networking | Documentation | Mirrored mode shares loopback; `ignoredPorts`; the `::1` note concerns Linux reaching Windows | https://learn.microsoft.com/en-us/windows/wsl/networking |
| WSL source | Source code | The last client gone ends the instance; a killed `wsl.exe` sends no signal; the localhost relay binds Windows loopback in the listener's own family; `--exec` and `--cd ~` usage text | github.com/microsoft/WSL at commit `91f161fa` (`src/windows/service/exe/LxssUserSession.cpp`, `src/linux/init/init.cpp`, `src/windows/wslrelay/localhost.cpp`, `localization/strings/en-US/Resources.resw`) |
| WSL issues 7560, 11280, 9231, 4636, 14005 | Issue tracker | Instances end with the Windows session; WSL cannot run as LocalSystem; session 0 reaches WSL only through the Program Files `wsl.exe`; a Windows program on a port breaks forwarding; a new `wsl.exe` can hang after sleep | https://github.com/microsoft/WSL/issues |
| JOBOBJECT_BASIC_LIMIT_INFORMATION | Documentation | Kill-on-close and silent breakaway | https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information |
| CreateNamedPipeW; Named Pipe Security and Access Rights | Documentation | `FILE_FLAG_FIRST_PIPE_INSTANCE` makes a second create fail with `ERROR_ACCESS_DENIED`; the default descriptor gives Everyone and anonymous read | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipew |
| CreateFileW | Documentation | Without `SECURITY_SQOS_PRESENT` and `SECURITY_IDENTIFICATION` a server may impersonate the caller fully | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew |
| Shutdown changes for Windows Vista | Documentation | A program with no visible window gets 5 seconds at `WM_QUERYENDSESSION` and `WM_ENDSESSION` | https://learn.microsoft.com/en-us/windows/win32/shutdown/shutdown-changes-for-windows-vista |
| SetThreadExecutionState | Documentation | `ES_CONTINUOUS` holds until the next call; it cannot stop a sleep the person asks for | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate |
| ToastNotificationHistory.Remove | Documentation | The remover must be part of the same app package as the poster | https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationhistory.remove |
| libuv | Source code | The Windows pipe server creates its pipe with a null descriptor and no remote-client refusal | github.com/libuv/libuv, 1.x branch, `src/win/pipe.c` |
| Node.js `http2.performServerHandshake` | Documentation | Added in Node 20.12.0 and 21.7.0 | https://nodejs.org/api/http2.html |
| HTTP/2 over a child's standard streams | Primary research | 50 MB up in 148 ms; 20 concurrent 1 MB in 81 ms; a 50 MB echo fails at the default session memory and passes at 128 MB (Node 26.8.1, on a Mac) | measured in this project's design work |
| `h2`, `windows`, `windows-native-keyring-store` | Package registry | 0.4.19, 0.62.2 and 1.1.0; the keyring store writes Enterprise persistence unless told `persistence=local` | https://crates.io |
| `@napi-rs/keyring` 2.1.0 | Source code | Passes only the entry's target, so every entry is written at Enterprise persistence | github.com/Brooooooklyn/keyring-node at tag 2.1.0 |
| Claude Code on WSL | Documentation | Sessions run in the distribution with native Linux paths; the distribution share is a network filesystem that breaks file watching | https://code.claude.com/docs/en/desktop-wsl |
| Codex on Windows and WSL | Documentation | WSL 2 supported, WSL 1 not; `CODEX_HOME` shared between sides | https://learn.chatgpt.com/docs/windows/wsl |
| Editors' WSL modes | Documentation | VS Code talks to its WSL server through `wsl.exe` and relies on WSL's port forwarding | https://code.visualstudio.com/docs/remote/wsl |
| `vercel/pkg` | Repository metadata | Archived, last push January 3, 2024 | https://github.com/vercel/pkg |

### Related ADRs

- [ADR-008](./008-default-transports-and-relay-boundaries.md) — the OS-local default and the rejection of loopback, which this decision keeps on a WSL computer.
- [ADR-021](./021-cli-identity-key-storage-custody.md) — every daemon secret as its own credential-store item; this decision puts the Windows store's calls in the Windows half for both sides.
- [ADR-028](./028-provider-credential-custody-posture.md) — provider credentials; a move carries each account's sign-in file, moved and never copied.
- [ADR-036](./036-embedded-browser-for-preview.md) — Preview; the Windows half carries a dev server's port when WSL cannot, the one listening port Preview opens.
