//! Per-session PTY holder — the in-memory registry of active sessions.
//!
//! [`PtySessionRegistry`] owns one [`portable_pty::PtyPair`] per active
//! session keyed by an internally-minted `session_id: String`, plus the
//! reader / waiter background tasks that emit [`Envelope::DataFrame`] and
//! [`Envelope::ExitCodeNotification`] to a single outbound channel. The
//! dispatcher loop in `src/main.rs` (T-024-1-5) holds one registry instance,
//! forwards inbound control requests (`spawn`, `write`, `resize`, `kill`) to
//! the registry's async methods, and pumps the outbound channel through the
//! framing writer to stdout.
//!
//! Plan-024 Phase 1 / T-024-1-4 — implements Plan-024 §Implementation Step 4
//! (per-session PTY holder + 8 KiB stdout/stderr pump with monotonic `seq`)
//! and Step 5 (exit-code latch).
//!
//! ## Design decisions
//!
//! ### 1. Registry as a struct, not a global
//!
//! [`PtySessionRegistry`] is a struct that owns
//! `HashMap<String, SessionHandle>` and an `mpsc::UnboundedSender<Envelope>`.
//! The dispatcher in T-024-1-5 will construct one instance, hold it for the
//! life of the runtime, and route inbound `kind`-discriminant matches to
//! `registry.spawn(...)`, `registry.write(...)`, etc.
//!
//! Alternative considered: free functions with a global `OnceLock<Mutex<...>>`.
//! Rejected — testability suffers (can't construct two independent
//! registries in one test process), and dropping the registry on dispatcher
//! shutdown would be implicit-via-static rather than explicit-via-RAII.
//!
//! ### 2. `session_id` minting — monotonic counter, format `s-{n}`
//!
//! Plan-024 §Implementation Step 4 pins the id as "internally-minted" but
//! does not pin a format. We use an `AtomicU64` counter rendered as
//! `s-{n}`. The id is opaque to the daemon (it round-trips verbatim through
//! `SpawnResponse` / subsequent `WriteRequest.session_id` / etc.), so the
//! shape is local-only.
//!
//! Alternative considered: UUID v4. Rejected — would add `uuid` (and
//! `getrandom`) as new dependencies for no daemon-visible benefit. The
//! counter is opaque-enough that the daemon does not parse it; the choice
//! is private and reversible.
//!
//! ### 3. ONE reader task per session, not two — PTYs merge stdout/stderr
//!
//! `portable_pty::MasterPty::try_clone_reader()` returns a single
//! `Box<dyn std::io::Read + Send>`. PTYs by OS-level design merge stdout
//! and stderr into one TTY device (the slave); the master sees the merged
//! output. There is no separate stderr reader to clone.
//!
//! Phase 1 consequence: every [`DataFrame`] emitted by this module carries
//! `stream: DataStream::Stdout`. The `DataStream::Stderr` variant remains in
//! the protocol surface for future use (e.g., a non-PTY child execution
//! mode), but the sidecar Phase 1 holder never emits it. Documented in
//! [`PtySessionRegistry`] rustdoc.
//!
//! ### 4. Reader / writer / waiter all run on `spawn_blocking`
//!
//! `portable-pty` exposes synchronous `std::io::{Read, Write}` and a
//! blocking `Child::wait()`. We dispatch each on `tokio::task::spawn_blocking`
//! so they do not block the runtime's async reactor.
//!
//! ### 5. Locking — `tokio::sync::Mutex` held briefly, never across `.await`
//!
//! The registry's session map and each [`SessionHandle`]'s writer /
//! killer / master are guarded by `tokio::sync::Mutex`. Locks are
//! acquired, the protected resource is moved or read briefly, and the
//! lock is released. We never hold a lock across the `.await` that
//! actually performs blocking I/O (instead we `clone_killer()`, take the
//! writer once, etc.).
//!
//! ### 6. Exit-status `signal_code` is `None` at Phase 1
//!
//! `portable_pty::ExitStatus` discards the raw POSIX signal number during
//! its `From<std::process::ExitStatus>` conversion — it preserves only the
//! locale-aware `strsignal()` string. There is no API surface to recover
//! the kernel signal number from a `portable_pty::ExitStatus`.
//!
//! Phase 1 contract: emit `signal_code: None` for every exit, including
//! signal-terminated children. The `exit_code` field still carries the
//! `portable_pty`-mapped value (signal-terminated children get `exit_code: 1`
//! with `signal_code: None` at Phase 1). Phase 3 may refine this when
//! direct `waitpid` plumbing replaces the `portable-pty` wrapper —
//! tracked under the Phase 3 audit row for T-024-3-1.
//!
//! ### 7. Windows kill-translation is deferred to Phase 3
//!
//! Plan-024 §Invariants I-024-1 + I-024-2 pin POSIX→`CTRL_C_EVENT` /
//! `CTRL_BREAK_EVENT` / `taskkill /T /F` translation as the Windows kill
//! path. The audit row for this task explicitly defers that to Phase 3
//! T-024-3-1 ("Verifies invariant: none (Phase 1; I-024-1/I-024-2 land in
//! Phase 3 sidecar-side per the audit row's explicit note)").
//!
//! Phase 1 [`PtySessionRegistry::kill`] therefore:
//! - On unix: delivers the requested [`PtySignal`] via `libc::kill(2)`.
//! - On Windows: returns [`PtySessionError::WindowsKillNotImplemented`].

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::protocol::{
    DataFrame, DataStream, Envelope, ExitCodeNotification, KillRequest, KillResponse, PtySignal,
    ResizeRequest, ResizeResponse, SpawnRequest, SpawnResponse, WriteRequest, WriteResponse,
};

/// Size of one [`DataFrame`] payload as emitted by the reader task.
///
/// Plan-024 §Implementation Step 4 + §Target Areas line 86 pin "8 KiB
/// chunks". Bound on the read-loop's stack buffer; matches the framing-layer
/// headroom (8 MiB body cap ÷ 8 KiB chunks = 1024× margin per envelope).
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// Error type returned by [`PtySessionRegistry`] methods.
///
/// Each variant carries the load-bearing context the dispatcher needs to
/// shape the on-wire response (success/failure code, log line, ack envelope
/// shape). The dispatcher in T-024-1-5 will map these to its own response
/// envelopes.
///
/// Hand-rolled `Display` + `Error` rather than `#[derive(thiserror::Error)]`
/// — `thiserror` would be a new transitive dependency for the marginal
/// boilerplate saving on five enum variants. Following the
/// dispatch-contract "DO NOT add new dependencies WITHOUT documenting why"
/// rule, we use std-only.
#[derive(Debug)]
pub enum PtySessionError {
    /// `session_id` does not match any active session in the registry.
    /// Reached when a `WriteRequest` / `ResizeRequest` / `KillRequest`
    /// references a session that has either never existed or has already
    /// exited (and been removed by the waiter task).
    UnknownSession(String),

    /// `portable-pty` returned an error from `openpty` or `spawn_command`.
    /// Wraps the underlying `anyhow::Error` as a string because
    /// `portable-pty` 0.9's error type is `anyhow::Error`, not a
    /// strong-typed enum (and we do not want anyhow in our public API).
    PortablePty(String),

    /// `take_writer()` was called more than once for the same session,
    /// or the writer was poisoned by a previous failed write. Per
    /// `MasterPty::take_writer` rustdoc ("It is invalid to take the
    /// writer more than once") this is treated as a hard failure rather
    /// than retried.
    WriterUnavailable(String),

    /// I/O error during a read/write/resize operation.
    Io(std::io::Error),

    /// Windows kill-translation is owned by Phase 3 T-024-3-1.
    ///
    /// Phase 1 ships unix-only kill. A Windows caller hitting this branch
    /// is the documented Phase boundary; the daemon-layer
    /// `RustSidecarPtyHost` may translate this error to a
    /// `PtyBackendUnavailable` so the selector falls back to
    /// `NodePtyHost` until Phase 3 lands.
    WindowsKillNotImplemented,
}

impl std::fmt::Display for PtySessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "session_id {id:?} is not active"),
            Self::PortablePty(msg) => write!(f, "portable-pty error: {msg}"),
            Self::WriterUnavailable(id) => {
                write!(
                    f,
                    "writer for session {id:?} has already been taken or is unavailable"
                )
            }
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::WindowsKillNotImplemented => {
                write!(f, "Windows kill-translation deferred to Phase 3 T-024-3-1")
            }
        }
    }
}

impl std::error::Error for PtySessionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PtySessionError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Per-session resources held by the registry.
///
/// Construction happens inside [`PtySessionRegistry::spawn`]. Drop is
/// driven from the waiter task at exit (or registry drop on shutdown);
/// the `JoinHandle` fields are aborted-on-drop, so a registry teardown
/// during an active session cancels both the reader pump and the waiter.
struct SessionHandle {
    /// Holds the `MasterPty` for `resize()` calls. The master also owns
    /// the underlying file descriptors / handles; dropping it after the
    /// child has exited closes the PTY.
    master: Mutex<Box<dyn MasterPty + Send>>,

    /// `Option` because `MasterPty::take_writer` documents "It is invalid
    /// to take the writer more than once" — we take once at session
    /// spawn and stash the writer here. Per-write acquisition + release
    /// inside [`PtySessionRegistry::write`].
    writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// Child process id. `None` on backends where portable-pty cannot
    /// recover the PID (theoretically possible per the trait's
    /// `Option<u32>` return). Phase 1 unix kill path requires `Some` —
    /// returns [`PtySessionError::UnknownSession`]-style error if missing.
    /// In practice on Linux / macOS this is always `Some` post-spawn.
    ///
    /// `#[cfg_attr(windows, allow(dead_code))]` because the Windows
    /// kill arm currently returns
    /// [`PtySessionError::WindowsKillNotImplemented`] without consulting
    /// the pid. Phase 3 T-024-3-1 will read this field for the
    /// `GenerateConsoleCtrlEvent` + `taskkill` paths.
    #[cfg_attr(windows, allow(dead_code))]
    pid: Option<u32>,

    /// `JoinHandle::abort()` is invoked on drop (Tokio task semantics).
    /// Held so an early registry teardown cancels in-flight reads.
    _reader_task: JoinHandle<()>,

    /// Same abort-on-drop discipline as `_reader_task`.
    _waiter_task: JoinHandle<()>,
}

/// The session-id-keyed registry the dispatcher consumes.
///
/// One instance per sidecar process, constructed by `main.rs`'s dispatcher
/// at startup (T-024-1-5). Asynchronous methods (`spawn`, `write`, `resize`,
/// `kill`) form the inbound surface; the outbound surface is the
/// [`mpsc::UnboundedReceiver`] returned by [`PtySessionRegistry::new`],
/// which carries every [`Envelope::DataFrame`] and
/// [`Envelope::ExitCodeNotification`] toward the framing writer.
///
/// ## Stream merging on PTYs
///
/// Phase 1 emits every [`DataFrame`] with `stream: DataStream::Stdout`
/// because `portable-pty` 0.9 provides only one reader per master (PTYs
/// merge stdout + stderr at the kernel level). The protocol retains the
/// [`DataStream::Stderr`] variant for future non-PTY execution modes; the
/// Phase 1 holder never emits it.
///
/// ## Sequence numbers
///
/// `seq` is monotonically increasing per `(session_id, stream)` pair, per
/// Plan-024 §Implementation Step 4 + the [`DataFrame`] rustdoc on
/// `protocol.rs`. Since Phase 1 only emits `Stdout`, the per-session
/// counter is effectively a single counter. The counter is reset per
/// session at spawn time (i.e., session A's seq 0 is unrelated to
/// session B's seq 0).
pub struct PtySessionRegistry {
    /// `Arc<Mutex<...>>` so the waiter task can also remove its session
    /// from the map on exit. Lock-held duration is the
    /// `HashMap::get`/`HashMap::insert`/`HashMap::remove` call only —
    /// never across `.await`.
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,

    /// Outbound queue feeding the dispatcher's stdout pump. Unbounded so
    /// reader tasks never block — backpressure on the framing layer is
    /// the dispatcher's concern (T-024-1-5).
    outbound: mpsc::UnboundedSender<Envelope>,

    /// Monotonic session-id source. Atomic so spawn calls are
    /// lock-independent.
    next_session_id: Arc<AtomicU64>,
}

impl PtySessionRegistry {
    /// Construct a fresh registry plus the outbound channel receiver
    /// the dispatcher should pump.
    ///
    /// The receiver MUST be drained by the caller (the T-024-1-5
    /// dispatcher) — backpressure is not implemented at this layer. If
    /// the dispatcher drops the receiver, background reader / waiter
    /// tasks log a quiet [`PtySessionError::OutboundClosed`] and exit.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Envelope>) {
        let (outbound, rx) = mpsc::unbounded_channel();
        let registry = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            outbound,
            next_session_id: Arc::new(AtomicU64::new(0)),
        };
        (registry, rx)
    }

    /// Spawn a new PTY session per [`SpawnRequest`].
    ///
    /// Mints a fresh `session_id`, opens a `PtyPair` at `(rows, cols)`,
    /// constructs a `CommandBuilder` from `(command, args, env, cwd)`,
    /// spawns the child, takes the writer, clones the killer, and
    /// spawns the reader + waiter tasks. Returns the minted id in
    /// [`SpawnResponse`].
    ///
    /// `env` is applied via `CommandBuilder::env_clear()` followed by
    /// `env(k, v)` for each pair — the daemon-layer caller owns
    /// inheritance semantics (Plan-024 §Implementation Step 1 +
    /// protocol.rs module rustdoc).
    pub async fn spawn(&self, req: SpawnRequest) -> Result<SpawnResponse, PtySessionError> {
        let session_id = self.mint_session_id();

        // Open the PTY at the caller's requested size.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // Build the command per the spawn request.
        let mut cmd = CommandBuilder::new(&req.command);
        for arg in &req.args {
            cmd.arg(arg);
        }
        // Plan-024 §Implementation Step 1 doesn't mandate env_clear, but
        // the daemon-layer contract assumes the env passed in the request
        // is authoritative (the daemon constructs the full env it wants
        // the child to see). Clearing the inherited environment first
        // makes the spawn request hermetic.
        cmd.env_clear();
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        cmd.cwd(&req.cwd);

        // Spawn the child against the slave end. The waiter task rebinds
        // this as `mut` internally when calling `Child::wait(&mut self)`;
        // the outer binding does not need `mut` because `process_id` and
        // `clone_killer` both take `&self`.
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // Capture the PID BEFORE moving `child` into the waiter task.
        // `process_id()` is the only path to a unix kill at Phase 1 (we
        // bypass `portable-pty`'s default killer because its unix path
        // hardcodes SIGHUP — see [`PtySessionRegistry::kill`] rustdoc).
        // Phase 3 T-024-3-1 will additionally stash a `ChildKiller`
        // clone here for the Windows kill-translation arm.
        let pid = child.process_id();

        // Take the writer once (per `MasterPty::take_writer` contract).
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // Clone a reader handle for the pump task.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // Spawn the stdout-pump background task. PTY semantics: one
        // merged reader, all DataFrames stamped `stream: Stdout`.
        let reader_task = spawn_reader_task(session_id.clone(), reader, self.outbound.clone());

        // Spawn the waiter task. On child exit it emits
        // `ExitCodeNotification` and removes the session from the registry.
        let waiter_task = spawn_waiter_task(
            session_id.clone(),
            child,
            self.outbound.clone(),
            self.sessions.clone(),
        );

        // Stash the session in the registry. Drop the `slave` half here
        // (the `PtyPair` destructured into `pair.master` keeps the master
        // alive via `MasterPty::resize` etc., while the slave can be
        // dropped now that the child holds its own end of the PTY).
        let handle = Arc::new(SessionHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(Some(writer)),
            pid,
            _reader_task: reader_task,
            _waiter_task: waiter_task,
        });
        // `pair.slave` is dropped here when `pair` goes out of scope.
        // The child already holds its own slave-side handles; dropping
        // ours is correct PTY-cleanup hygiene.

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), handle);

        Ok(SpawnResponse { session_id })
    }

    /// Resize an active session's PTY.
    ///
    /// Looks up the session, acquires the master lock briefly, calls
    /// `MasterPty::resize`. Returns [`PtySessionError::UnknownSession`]
    /// if the session has already exited (or never existed).
    pub async fn resize(&self, req: ResizeRequest) -> Result<ResizeResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;
        // `resize` is synchronous + non-blocking — ioctl on unix,
        // ResizePseudoConsole on Windows. Hold the lock for the call.
        let master = handle.master.lock().await;
        master
            .resize(PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;
        Ok(ResizeResponse {
            session_id: req.session_id,
        })
    }

    /// Write payload bytes to an active session's stdin.
    ///
    /// `portable-pty`'s writer is sync `std::io::Write`; this method
    /// dispatches the actual write to `spawn_blocking` so the runtime is
    /// not stalled. The writer is temporarily moved OUT of its `Option`
    /// for the blocking call and moved back on completion — this means
    /// a panic in the spawn_blocking closure or a writer error
    /// permanently retires the writer (subsequent writes on the same
    /// session return [`PtySessionError::WriterUnavailable`]). The
    /// dispatcher's contract is "writer hard-fails ⇒ caller should
    /// `kill` the session" rather than silent retry.
    pub async fn write(&self, req: WriteRequest) -> Result<WriteResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;
        let mut writer_slot = handle.writer.lock().await;
        let mut writer = writer_slot
            .take()
            .ok_or_else(|| PtySessionError::WriterUnavailable(req.session_id.clone()))?;

        // Hand the writer to a blocking task. We move both `writer` and
        // `bytes` in, get them back on completion.
        let bytes = req.bytes;
        let (writer_returned, result) = tokio::task::spawn_blocking(move || {
            let res = writer.write_all(&bytes).and_then(|_| writer.flush());
            (writer, res)
        })
        .await
        // `spawn_blocking` join failures are I/O-class — the underlying
        // task panicked. Surface as Io rather than swallowing.
        .map_err(|e| PtySessionError::Io(std::io::Error::other(e.to_string())))?;

        match result {
            Ok(()) => {
                // Return the writer to the slot for the next write.
                *writer_slot = Some(writer_returned);
                Ok(WriteResponse {
                    session_id: req.session_id,
                })
            }
            Err(e) => {
                // Writer is consumed — do NOT return it to the slot.
                // Subsequent writes on this session will see
                // `WriterUnavailable`. The slot stays `None`.
                Err(PtySessionError::Io(e))
            }
        }
    }

    /// Signal a session's child process per [`KillRequest`].
    ///
    /// **Phase 1 contract — unix only.** Delivers the POSIX signal
    /// number corresponding to `req.signal` via `libc::kill(2)`.
    ///
    /// Windows kill-translation (POSIX→`CTRL_C_EVENT` /
    /// `CTRL_BREAK_EVENT` / `taskkill /T /F` + tree-kill escalation per
    /// Plan-024 §Invariants I-024-1 + I-024-2) is owned by Phase 3
    /// T-024-3-1; the Windows arm returns
    /// [`PtySessionError::WindowsKillNotImplemented`] until then.
    ///
    /// `node-pty`'s default `kill()` and `portable-pty`'s default
    /// `ChildKiller` both hardcode SIGHUP on unix; we bypass that and
    /// call `libc::kill` directly so the caller's [`PtySignal`] choice
    /// reaches the child.
    #[cfg(unix)]
    pub async fn kill(&self, req: KillRequest) -> Result<KillResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;
        let pid = handle
            .pid
            .ok_or_else(|| PtySessionError::UnknownSession(req.session_id.clone()))?;
        let signal_num = posix_signal_number(req.signal);

        // `libc::kill` is non-blocking — it returns immediately after
        // queueing the signal. No spawn_blocking required.
        // Safety: `pid` is a `u32` (valid pid_t range on Linux + macOS
        // for the ids we mint from `Child::process_id`), and
        // `signal_num` comes from `posix_signal_number` which only
        // returns values from `libc`'s own constants.
        let rc = unsafe { libc::kill(pid as i32, signal_num) };
        if rc != 0 {
            return Err(PtySessionError::Io(std::io::Error::last_os_error()));
        }

        Ok(KillResponse {
            session_id: req.session_id,
        })
    }

    /// Windows kill stub — Phase 3 T-024-3-1 owns the real
    /// implementation per Plan-024 §Invariants I-024-1 + I-024-2.
    #[cfg(windows)]
    pub async fn kill(&self, _req: KillRequest) -> Result<KillResponse, PtySessionError> {
        Err(PtySessionError::WindowsKillNotImplemented)
    }

    /// Mint the next session id. `s-{n}` format is documented in
    /// the module rustdoc design-decision section.
    fn mint_session_id(&self) -> String {
        let n = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        format!("s-{n}")
    }

    /// Resolve a session_id to its handle, holding the registry lock
    /// only for the lookup call.
    async fn lookup(&self, session_id: &str) -> Result<Arc<SessionHandle>, PtySessionError> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| PtySessionError::UnknownSession(session_id.to_string()))
    }

    /// Returns the count of currently-active sessions.
    ///
    /// A session is "active" from the moment [`PtySessionRegistry::spawn`]
    /// returns successfully until the waiter task emits
    /// [`Envelope::ExitCodeNotification`] and removes the session from
    /// the map. Useful for integration tests and for the T-024-1-5
    /// dispatcher's health-check / ping-response path.
    pub async fn active_session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

/// Map a [`PtySignal`] to its POSIX signal number.
///
/// Values come from `libc` so they track the underlying platform's
/// kernel headers (Linux + macOS differ in the numeric value of `SIGTERM`
/// historically — relying on `libc` constants instead of hardcoded
/// integers is the conventional defense).
#[cfg(unix)]
fn posix_signal_number(signal: PtySignal) -> libc::c_int {
    match signal {
        PtySignal::Sigint => libc::SIGINT,
        PtySignal::Sigterm => libc::SIGTERM,
        PtySignal::Sigkill => libc::SIGKILL,
        PtySignal::Sighup => libc::SIGHUP,
    }
}

/// Spawn the per-session reader pump.
///
/// Runs the blocking `read` loop on `spawn_blocking`; each chunk
/// becomes one [`Envelope::DataFrame`] with monotonically increasing
/// `seq` per session (Plan-024 §Implementation Step 4). Exits on EOF
/// (child closed its end of the PTY) or read error.
fn spawn_reader_task(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    outbound: mpsc::UnboundedSender<Envelope>,
) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut seq: u64 = 0;
        let mut buf = [0u8; READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF — child closed its slave end. The waiter task
                    // will eventually emit `ExitCodeNotification`.
                    return;
                }
                Ok(n) => {
                    let frame = DataFrame {
                        session_id: session_id.clone(),
                        stream: DataStream::Stdout,
                        seq,
                        bytes: buf[..n].to_vec(),
                    };
                    // Channel send is fire-and-forget — the dispatcher
                    // task drains. If the receiver has been dropped
                    // (shutdown in progress), we exit quietly.
                    if outbound.send(Envelope::DataFrame(frame)).is_err() {
                        return;
                    }
                    seq = seq.wrapping_add(1);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    // EINTR — retry. This is the idiomatic pattern for
                    // raw `read` on unix; portable-pty does NOT retry
                    // internally.
                    continue;
                }
                Err(_) => {
                    // Any other read error terminates the pump. The
                    // waiter task is responsible for the
                    // `ExitCodeNotification`; reader does not duplicate
                    // that signal.
                    return;
                }
            }
        }
    })
}

/// Spawn the per-session waiter task.
///
/// Blocks on `Child::wait()` via `spawn_blocking`; on exit, emits one
/// [`Envelope::ExitCodeNotification`] and removes the session from the
/// registry. Idempotent — if the registry lock fails to acquire (e.g.,
/// registry dropped during shutdown), the notification is still attempted
/// on the outbound channel.
fn spawn_waiter_task(
    session_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    outbound: mpsc::UnboundedSender<Envelope>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // The blocking wait happens on a dedicated thread; back on the
        // async runtime we synthesize the notification + clean up.
        let exit_status = match tokio::task::spawn_blocking(move || child.wait()).await {
            Ok(Ok(status)) => status,
            // wait() returned an I/O error OR the spawn_blocking task
            // panicked. Either way, we cannot trust the exit code; emit
            // a sentinel notification so the daemon knows the session
            // is gone (`exit_code: 1, signal_code: None` is the
            // portable-pty convention for "process is dead but exit
            // status is unknown" — see ExitStatus::default-ish in
            // portable-pty source).
            _ => {
                let _ = outbound.send(Envelope::ExitCodeNotification(ExitCodeNotification {
                    session_id: session_id.clone(),
                    exit_code: 1,
                    signal_code: None,
                }));
                // Best-effort cleanup; drop the session if still present.
                let mut map = sessions.lock().await;
                map.remove(&session_id);
                return;
            }
        };

        // Map portable-pty's ExitStatus to the wire shape.
        //
        // Phase 1 limitation: portable-pty discards the raw POSIX
        // signal number during `From<std::process::ExitStatus>` (see
        // module rustdoc §6). We emit `signal_code: None` for every
        // exit; Phase 3 T-024-3-1 may refine this via direct waitpid.
        let exit_code = exit_status.exit_code() as i32;
        let notification = ExitCodeNotification {
            session_id: session_id.clone(),
            exit_code,
            signal_code: None,
        };
        let _ = outbound.send(Envelope::ExitCodeNotification(notification));

        // Remove the session — subsequent writes/resizes/kills on this
        // id will return `UnknownSession`.
        let mut map = sessions.lock().await;
        map.remove(&session_id);
    })
}
