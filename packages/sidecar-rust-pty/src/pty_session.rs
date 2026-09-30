//! In-memory registry of active PTY sessions.
//!
//! [`PtySessionRegistry`] owns one [`portable_pty::PtyPair`] per session, keyed by a minted
//! `session_id`, plus the reader and waiter tasks that emit [`Envelope::DataFrame`] and
//! [`Envelope::ExitCodeNotification`] on one outbound channel. The dispatcher in `src/main.rs`
//! holds one registry, forwards `spawn`, `write`, `resize` and `kill` to it, and pumps the outbound
//! channel to stdout.
//!
//! ## Design decisions
//!
//! - **Ids** are `s-{n}` from an `AtomicU64` counter. The daemon treats them as opaque, so no UUID
//!   dependency is needed.
//! - **One reader per session.** A PTY merges stdout and stderr and `try_clone_reader` returns a
//!   single reader, so every [`DataFrame`] carries `DataStream::Stdout`; `DataStream::Stderr` is
//!   never emitted.
//! - **Blocking I/O** (read, write, `Child::wait`) runs on `spawn_blocking` so it cannot stall the
//!   async reactor.
//! - **Locking.** The per-session `writer` mutex is held across the blocking write so writes cannot
//!   interleave. The `sessions` and `master` mutexes are held only for map operations and `resize`,
//!   never across blocking I/O. `exited` is a lock-free `AtomicBool`, so the kill path takes no
//!   lock.
//! - **`signal_code` is always `None`.** portable-pty keeps only a `strsignal()` string and drops
//!   the signal number, and a signal-terminated child reports `exit_code` 1.
//! - **Kill.** On unix [`PtySessionRegistry::kill`] delivers the requested [`PtySignal`] with
//!   `libc::kill(2)`; on Windows it returns [`PtySessionError::WindowsKillNotImplemented`].

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::protocol::{
    DataFrame, DataStream, Envelope, ExitCodeNotification, KillRequest, KillResponse, PtySignal,
    ResizeRequest, ResizeResponse, SpawnRequest, SpawnResponse, WriteRequest, WriteResponse,
};

/// `(killer, pid)` for one session. The [`ChildKiller`] clone lets `Drop` soft-kill the child; the
/// pid lets the unix `Drop` escalate to SIGKILL, and is `None` when portable-pty cannot report one
/// (no escalation then).
///
/// An alias because `clippy::type_complexity` flags the nested type.
type KillerEntry = (Box<dyn ChildKiller + Send + Sync>, Option<u32>);

/// Read buffer size, so one [`DataFrame`] carries at most 8 KiB.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// Errors from [`PtySessionRegistry`] methods; the dispatcher sends each as the `error` string of
/// the wire response.
///
/// `Display` and `Error` are written by hand to avoid a `thiserror` dependency for six variants.
#[derive(Debug)]
pub enum PtySessionError {
    /// `session_id` matches no active session: it never existed or has exited.
    UnknownSession(String),

    /// `portable-pty` failed in `openpty`, `spawn_command` or another call; its `anyhow::Error` is
    /// kept as a string.
    PortablePty(String),

    /// The session's writer was already taken, or a failed write retired it.
    WriterUnavailable(String),

    /// I/O error during a read/write/resize operation.
    Io(std::io::Error),

    /// The Windows kill path does not exist yet, so [`PtySessionRegistry::kill`] returns this on
    /// Windows.
    ///
    /// The `allow(dead_code)` below is needed off Windows because only the Windows `kill` arm
    /// constructs this variant. It is `allow` rather than `expect` because the lib build sees the
    /// `pub` variant as live and an `expect` would fail there as unfulfilled.
    #[cfg_attr(not(windows), allow(dead_code))]
    WindowsKillNotImplemented,

    /// The platform reported no pid for the child, so it cannot be signaled. Distinct from
    /// `UnknownSession` because the session does exist.
    PidUnavailable(String),
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
                write!(f, "Windows kill-translation deferred to Phase 3")
            }
            Self::PidUnavailable(id) => write!(
                f,
                "session_id {id:?} has no pid available; kill cannot proceed"
            ),
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
/// [`PtySessionRegistry::spawn`] inserts the handle and the waiter task removes it at exit. The
/// reader and waiter [`JoinHandle`]s are detached: the reader ends at PTY EOF and the waiter when
/// `Child::wait` returns.
struct SessionHandle {
    /// Kept for `resize`; dropping it after the child exits closes the PTY.
    master: Mutex<Box<dyn MasterPty + Send>>,

    /// `Option` because `MasterPty::take_writer` may be called only once; a failed write leaves
    /// `None`.
    writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// `None` when portable-pty cannot report a pid; unix `kill` then fails with
    /// [`PtySessionError::PidUnavailable`].
    ///
    /// `allow(dead_code)` on Windows because the Windows kill arm does not read it.
    #[cfg_attr(windows, allow(dead_code))]
    pid: Option<u32>,

    /// Set once the waiter has seen `Child::wait()` return.
    ///
    /// `wait()` reaps the child, so its pid can be recycled from that moment while the session is
    /// still in the map. The waiter stores `true` with `Release` inside its `spawn_blocking`
    /// closure, on the thread that reaped, and `kill` loads it with `Acquire` and returns
    /// `UnknownSession` when set. That narrows the window in which `kill` could signal a recycled
    /// pid to a few instructions; it does not close it. `Release`/`Acquire` is enough because only
    /// one atomic is involved, and `Relaxed` would let the pid read move past the load.
    ///
    /// `Arc` so the waiter task holds its own handle.
    exited: Arc<std::sync::atomic::AtomicBool>,
}

/// The session-keyed registry the dispatcher drives; one per sidecar process.
///
/// `spawn`, `write`, `resize` and `kill` are the inbound surface. The receiver from
/// [`PtySessionRegistry::new`] carries every [`Envelope::DataFrame`] and
/// [`Envelope::ExitCodeNotification`] outbound. Every frame is `DataStream::Stdout` (see the module
/// docs), so `seq` is one counter per session that starts at 0.
pub struct PtySessionRegistry {
    /// `Arc` so the waiter can remove its session at exit; the lock is held only for a map call.
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,

    /// Unbounded so reader tasks never block; backpressure is the dispatcher's concern.
    outbound: mpsc::UnboundedSender<Envelope>,

    /// Atomic so spawns need no lock.
    next_session_id: Arc<AtomicU64>,

    /// Per-session `(ChildKiller, pid)`, used by `Drop` to terminate children still running when
    /// the registry is dropped.
    ///
    /// The pid is stored here because `Drop` cannot reach `SessionHandle` (behind the async mutex)
    /// and the unix SIGKILL escalation needs it. A `std::sync::Mutex` is used because `Drop` cannot
    /// await. `spawn()` inserts an entry; the waiter removes it inside its `spawn_blocking`
    /// closure, on the thread that reaped, so `Drop` rarely sees a stale killer for a recycled pid.
    /// The waiter's later removals are a fallback for a panicked closure. A soft-kill error in
    /// `Drop` is logged and skips the escalation, since the child is already gone.
    killers: Arc<std::sync::Mutex<HashMap<String, KillerEntry>>>,
}

impl PtySessionRegistry {
    /// Creates a registry and the receiver of its outbound events.
    ///
    /// The caller must drain the receiver: nothing applies backpressure here. If it is dropped,
    /// reader tasks exit at their next send and waiters log the lost notification.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Envelope>) {
        let (outbound, rx) = mpsc::unbounded_channel();
        let registry = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            outbound,
            next_session_id: Arc::new(AtomicU64::new(0)),
            killers: Arc::new(std::sync::Mutex::new(HashMap::new())),
        };
        (registry, rx)
    }

    /// Spawns a PTY session per [`SpawnRequest`] and returns its minted id.
    ///
    /// `env` is applied after `env_clear()`, so the daemon decides what the child inherits. Returns
    /// [`PtySessionError::PortablePty`] if opening the PTY, spawning, or taking the reader or
    /// writer fails.
    pub async fn spawn(&self, req: SpawnRequest) -> Result<SpawnResponse, PtySessionError> {
        let session_id = self.mint_session_id();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&req.command);
        for arg in &req.args {
            cmd.arg(arg);
        }
        // Start from an empty environment so the spawn is hermetic.
        cmd.env_clear();
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        cmd.cwd(&req.cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // Capture the pid before `child` moves into the waiter; portable-pty's own killer sends
        // only SIGHUP, so unix `kill` needs it.
        let pid = child.process_id();

        // Clone a killer before `child` moves into the waiter; `Drop` uses it. It must be `Sync`
        // because the map is shared across threads.
        let killer = child.clone_killer();

        // `take_writer` may be called only once.
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtySessionError::PortablePty(e.to_string()))?;

        // The waiter sets this right after `Child::wait()` returns; see `SessionHandle::exited`.
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Insert the handle before spawning the tasks: a fast-exiting child could otherwise finish
        // the waiter's `map.remove` before this insert and leak an entry for a reaped session.
        let handle = Arc::new(SessionHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(Some(writer)),
            pid,
            exited: Arc::clone(&exited),
        });

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), handle);

        // Inserted after `sessions`, so a session in `killers` is also in `sessions` (or the waiter
        // is mid-cleanup). The pid rides along for the `Drop` escalation. A poisoned mutex means a
        // panic in a short critical section, so surface it.
        self.killers
            .lock()
            .expect("killers mutex poisoned")
            .insert(session_id.clone(), (killer, pid));

        // One merged reader, so every frame is `Stdout`. The waiter awaits it before emitting the
        // exit notification.
        let reader_task = spawn_reader_task(session_id.clone(), reader, self.outbound.clone());

        // The insert above has completed, so the waiter's `map.remove` cannot race it. The task is
        // detached and ends by itself.
        let _waiter_task = spawn_waiter_task(
            session_id.clone(),
            child,
            exited,
            self.outbound.clone(),
            self.sessions.clone(),
            self.killers.clone(),
            reader_task,
        );

        Ok(SpawnResponse {
            session_id,
            error: None,
        })
    }

    /// Resizes an active session's PTY.
    ///
    /// Returns [`PtySessionError::UnknownSession`] if the session has exited or never existed.
    pub async fn resize(&self, req: ResizeRequest) -> Result<ResizeResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;
        // Non-blocking (ioctl on unix, ResizePseudoConsole on Windows), so holding the lock is
        // fine.
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
            error: None,
        })
    }

    /// Writes bytes to an active session's stdin on a `spawn_blocking` task.
    ///
    /// The writer is taken out of its slot for the blocking call, so a write error or a panic
    /// retires it: later writes return [`PtySessionError::WriterUnavailable`], and the caller
    /// should kill the session.
    pub async fn write(&self, req: WriteRequest) -> Result<WriteResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;
        let mut writer_slot = handle.writer.lock().await;
        let mut writer = writer_slot
            .take()
            .ok_or_else(|| PtySessionError::WriterUnavailable(req.session_id.clone()))?;

        let bytes = req.bytes;
        let (writer_returned, result) = tokio::task::spawn_blocking(move || {
            let res = writer.write_all(&bytes).and_then(|_| writer.flush());
            (writer, res)
        })
        .await
        // A join failure means the task panicked; surface it as `Io`.
        .map_err(|e| PtySessionError::Io(std::io::Error::other(e.to_string())))?;

        match result {
            Ok(()) => {
                *writer_slot = Some(writer_returned);
                Ok(WriteResponse {
                    session_id: req.session_id,
                    error: None,
                })
            }
            Err(e) => {
                // The writer is consumed on error; the slot stays `None`.
                Err(PtySessionError::Io(e))
            }
        }
    }

    /// Signals a session's child with `libc::kill(2)`, delivering the requested [`PtySignal`]
    /// instead of portable-pty's hardcoded SIGHUP.
    ///
    /// Returns `UnknownSession` for an unknown session or one whose exit the waiter has already
    /// seen (the pid-recycling guard on `SessionHandle::exited`), `PidUnavailable` when there is
    /// no pid, and `Io` when the syscall fails.
    #[cfg(unix)]
    pub async fn kill(&self, req: KillRequest) -> Result<KillResponse, PtySessionError> {
        let handle = self.lookup(&req.session_id).await?;

        // Guard against a recycled pid: the waiter has already reaped the child.
        if handle.exited.load(std::sync::atomic::Ordering::Acquire) {
            return Err(PtySessionError::UnknownSession(req.session_id.clone()));
        }

        let pid = handle
            .pid
            .ok_or_else(|| PtySessionError::PidUnavailable(req.session_id.clone()))?;
        let signal_num = posix_signal_number(req.signal);

        // Non-blocking. Safety: `pid` comes from `Child::process_id` and `signal_num` from `libc`
        // constants.
        let rc = unsafe { libc::kill(pid as i32, signal_num) };
        if rc != 0 {
            return Err(PtySessionError::Io(std::io::Error::last_os_error()));
        }

        Ok(KillResponse {
            session_id: req.session_id,
            error: None,
        })
    }

    /// Windows stub that always returns [`PtySessionError::WindowsKillNotImplemented`]; the helpers
    /// in `kill_translation` and `tree_kill` are not wired in yet.
    #[cfg(windows)]
    pub async fn kill(&self, _req: KillRequest) -> Result<KillResponse, PtySessionError> {
        Err(PtySessionError::WindowsKillNotImplemented)
    }

    fn mint_session_id(&self) -> String {
        let n = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        format!("s-{n}")
    }

    async fn lookup(&self, session_id: &str) -> Result<Arc<SessionHandle>, PtySessionError> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| PtySessionError::UnknownSession(session_id.to_string()))
    }
}

/// How long `Drop` waits after the soft kill (SIGHUP) before sending SIGKILL to a child that is
/// still alive.
///
/// One second lets a well-behaved child run its exit handlers without stalling shutdown on children
/// that ignore SIGHUP. Each such child costs one detached OS thread while it waits.
#[cfg(unix)]
const DROP_KILL_ESCALATION_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1000);

/// Terminates children still running when the registry drops, so `main()` can finish.
///
/// Without this, the reader and waiter tasks of an idle session (say `sleep 30`) keep their
/// outbound-sender clones alive, the writer channel never closes, and `main()` hangs awaiting the
/// writer. `Drop` soft-kills each remaining child ([`ChildKiller::kill`]: SIGHUP on unix,
/// `TerminateProcess` on Windows). The child's exit closes the PTY, the reader sees EOF, the
/// waiter's `wait()` returns, every sender clone drops, and the writer exits. Killing is the only
/// route, because `JoinHandle::abort` does nothing to a `spawn_blocking` task that has started.
///
/// On unix a detached thread then waits `DROP_KILL_ESCALATION_DEADLINE`, checks the pid with
/// `kill(pid, 0)`, and sends SIGKILL if it is still alive, since a child can ignore SIGHUP
/// (`trap '' HUP`). A thread is used because `Drop` cannot await and the tokio runtime may be
/// shutting down. Windows needs no escalation because `TerminateProcess` cannot be ignored, but it
/// kills only that one process, so grandchildren are orphaned.
///
/// The escalation cannot use the `exited` guard that in-band `kill` has: `Drop` cannot reach the
/// handle, and `kill(pid, 0)` cannot tell the original child from a process that reused its pid.
/// Never escalating would let a SIGHUP-ignoring child hang shutdown, so a rare SIGKILL to a
/// recycled pid within the one-second window is accepted: pids are handed out in increasing order
/// with wraparound (Linux `pid_max` defaults to 32768, macOS to 99999), so the kernel does not
/// normally reuse one that fast, and the kill can only reach processes the same user owns.
///
/// A soft-kill error (usually ESRCH for an already-reaped child) is logged and skips the
/// escalation, because the child is gone.
impl Drop for PtySessionRegistry {
    fn drop(&mut self) {
        // Recover from a poisoned lock: `Drop` must not double-panic.
        let mut killers_guard = match self.killers.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (session_id, (mut killer, _pid)) in killers_guard.drain() {
            // Soft kill: SIGHUP on unix, `TerminateProcess` on Windows.
            if let Err(err) = killer.kill() {
                // ESRCH on an already-reaped child is expected; skip the escalation because the
                // child is gone.
                eprintln!(
                    "pty_session registry drop ({session_id:?}): soft kill on child failed: {err}"
                );
                continue;
            }

            // Unix escalation. `Builder::spawn` rather than `thread::spawn`, which panics when the
            // OS cannot create a thread and would skip the writer drain in `main()`; on failure
            // this session's escalation is skipped.
            #[cfg(unix)]
            if let Some(pid) = _pid {
                let session_id_for_thread = session_id.clone();
                let _ = std::thread::Builder::new()
                    .name(format!("pty-drop-escalation-{session_id_for_thread}"))
                    .spawn(move || {
                        std::thread::sleep(DROP_KILL_ESCALATION_DEADLINE);
                        // SAFETY: signal 0 only tests for existence, and the pid fits `pid_t`.
                        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
                        if alive {
                            // SAFETY: as above. The recycled-pid trade-off is documented on this
                            // `Drop` impl.
                            let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
                            if rc != 0 {
                                // ESRCH between the check and the kill is a tiny race; log it only.
                                eprintln!(
                                    "pty_session registry drop ({session_id_for_thread:?}): \
                                     SIGKILL escalation returned errno {} (likely ESRCH \
                                     from a between-check-and-kill race; child is gone)",
                                    std::io::Error::last_os_error()
                                );
                            }
                        }
                    });
            }
        }
    }
}

/// Maps a [`PtySignal`] to its `libc` signal number, which is correct for each platform.
#[cfg(unix)]
fn posix_signal_number(signal: PtySignal) -> libc::c_int {
    match signal {
        PtySignal::Sigint => libc::SIGINT,
        PtySignal::Sigterm => libc::SIGTERM,
        PtySignal::Sigkill => libc::SIGKILL,
        PtySignal::Sighup => libc::SIGHUP,
    }
}

/// Spawns the blocking read loop for one session.
///
/// Each chunk becomes one [`Envelope::DataFrame`] with an increasing per-session `seq`. The loop
/// ends at EOF or a read error; the waiter owns the exit notification.
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
                    // EOF: the child closed its slave end.
                    return;
                }
                Ok(n) => {
                    let frame = DataFrame {
                        session_id: session_id.clone(),
                        stream: DataStream::Stdout,
                        seq,
                        bytes: buf[..n].to_vec(),
                    };
                    // A send error means the receiver is gone (shutdown), so stop quietly.
                    if outbound.send(Envelope::DataFrame(frame)).is_err() {
                        return;
                    }
                    seq = seq.wrapping_add(1);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    // Retry on EINTR; portable-pty does not.
                    continue;
                }
                Err(_) => {
                    // Any other read error ends the pump; the waiter reports the exit.
                    return;
                }
            }
        }
    })
}

/// Spawns the per-session waiter.
///
/// It blocks in `Child::wait()`, awaits `reader_task` to EOF so every trailing [`DataFrame`]
/// precedes the [`Envelope::ExitCodeNotification`], sends the notification, and removes the
/// session. `exited` is stored with `Release` inside the `spawn_blocking` closure (see
/// [`SessionHandle::exited`]).
///
/// ## No drain timeout
///
/// The reader is awaited without a timeout because `JoinHandle::abort` cannot stop a
/// `spawn_blocking` closure that is running: a timeout would let the reader emit `DataFrame`s after
/// the notification and leak a pool thread. EOF normally arrives within milliseconds of the child
/// exiting; if a surviving process holds the slave open, the waiter blocks until it closes.
/// Ordering takes priority over progress on a stuck PTY.
fn spawn_waiter_task(
    session_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    exited: Arc<std::sync::atomic::AtomicBool>,
    outbound: mpsc::UnboundedSender<Envelope>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    killers: Arc<std::sync::Mutex<HashMap<String, KillerEntry>>>,
    reader_task: JoinHandle<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // Store `exited` right after `wait()` returns, on the reaping thread; see
        // `SessionHandle::exited`.
        let exited_for_closure = Arc::clone(&exited);
        let killers_for_closure = Arc::clone(&killers);
        let session_id_for_closure = session_id.clone();
        let join_result = tokio::task::spawn_blocking(move || {
            let result = child.wait();
            exited_for_closure.store(true, std::sync::atomic::Ordering::Release);
            // Drop the killer here too, on the reaping thread, so `Drop` never sees a stale killer
            // for a recycled pid. The removals below are a fallback for a panicked closure.
            let _ = killers_for_closure
                .lock()
                .expect("killers mutex poisoned")
                .remove(&session_id_for_closure);
            result
        })
        .await;

        // Drain the reader before notifying, so every `DataFrame` reaches the channel first; no
        // timeout (see above). A panicked reader is ignored: nothing in the notification depends on
        // it.
        let _ = reader_task.await;

        // Both wait failures (an `io::Error`, or a panicked wait thread) report exit code 1 with no
        // signal; the stderr line tells them apart.
        let exit_status = match join_result {
            Ok(Ok(status)) => status,
            Ok(Err(io_err)) => {
                eprintln!(
                    "pty_session waiter ({session_id:?}): Child::wait() returned io::Error: {io_err}"
                );
                // Fallback in case the closure failed before its store.
                exited.store(true, std::sync::atomic::Ordering::Release);
                let notification = ExitCodeNotification {
                    session_id: session_id.clone(),
                    exit_code: 1,
                    signal_code: None,
                };
                // A waiter cannot propagate to `main()`: if the writer is dead the notification is
                // lost, so log it and still clean up.
                if let Err(send_err) = outbound.send(Envelope::ExitCodeNotification(notification)) {
                    eprintln!(
                        "pty_session waiter ({session_id:?}): outbound channel closed (writer dead); \
                         lost exit notification: {send_err}"
                    );
                }
                let mut map = sessions.lock().await;
                map.remove(&session_id);
                // Fallback removal; a no-op when the closure already removed it.
                killers
                    .lock()
                    .expect("killers mutex poisoned")
                    .remove(&session_id);
                return;
            }
            Err(join_err) => {
                eprintln!(
                    "pty_session waiter ({session_id:?}): spawn_blocking join failed (wait thread panicked): {join_err}"
                );
                // Fallback, as above.
                exited.store(true, std::sync::atomic::Ordering::Release);
                let notification = ExitCodeNotification {
                    session_id: session_id.clone(),
                    exit_code: 1,
                    signal_code: None,
                };
                // As above: log the lost notification and continue the cleanup.
                if let Err(send_err) = outbound.send(Envelope::ExitCodeNotification(notification)) {
                    eprintln!(
                        "pty_session waiter ({session_id:?}): outbound channel closed (writer dead); \
                         lost exit notification: {send_err}"
                    );
                }
                let mut map = sessions.lock().await;
                map.remove(&session_id);
                // Needed here: a panicked closure never ran its removal.
                killers
                    .lock()
                    .expect("killers mutex poisoned")
                    .remove(&session_id);
                return;
            }
        };

        // portable-pty drops the signal number (see the module docs), so `signal_code` is always
        // `None`. The `as i32` wrap lets Windows NTSTATUS codes such as 0xC0000005 round-trip as
        // negative values.
        let exit_code = exit_status.exit_code() as i32;
        let notification = ExitCodeNotification {
            session_id: session_id.clone(),
            exit_code,
            signal_code: None,
        };
        // As above: log the lost notification and continue the cleanup.
        if let Err(send_err) = outbound.send(Envelope::ExitCodeNotification(notification)) {
            eprintln!(
                "pty_session waiter ({session_id:?}): outbound channel closed (writer dead); \
                 lost exit notification: {send_err}"
            );
        }

        // Later writes, resizes and kills on this id return `UnknownSession`.
        let mut map = sessions.lock().await;
        map.remove(&session_id);
        // Fallback removal; a no-op when the closure already removed it.
        killers
            .lock()
            .expect("killers mutex poisoned")
            .remove(&session_id);
    })
}

/// White-box tests of the registry's private `sessions` map: a session is present from `spawn`
/// until the waiter removes it at exit.
///
/// Unix only, since the children are `/bin/sh`. `main.rs` also declares `mod pty_session;`, so
/// these tests run in both the lib and bin test harnesses. The helpers are copies of those in
/// `tests/pty_session.rs`, which cannot share code with this crate.
#[cfg(all(test, unix))]
mod registry_lifecycle_tests {
    use std::time::Duration;
    use tokio::time::timeout;

    use super::*;

    /// Budget for a child to exit and its `ExitCodeNotification` to arrive.
    const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

    /// Collects envelopes from `rx` until an `ExitCodeNotification` arrives or `EXIT_TIMEOUT`
    /// elapses.
    async fn drain_until_exit(rx: &mut mpsc::UnboundedReceiver<Envelope>) -> Vec<Envelope> {
        let mut envelopes = Vec::new();
        let deadline_fut = timeout(EXIT_TIMEOUT, async {
            loop {
                match rx.recv().await {
                    Some(env) => {
                        let is_exit = matches!(env, Envelope::ExitCodeNotification(_));
                        envelopes.push(env);
                        if is_exit {
                            return;
                        }
                    }
                    None => return,
                }
            }
        });
        let _ = deadline_fut.await;
        envelopes
    }

    /// An empty env keeps the spawn minimal; the lifecycle tests do not need one.
    fn empty_env() -> Vec<(String, String)> {
        Vec::new()
    }

    #[tokio::test]
    async fn active_session_count_tracks_lifecycle() {
        // A session is inserted at spawn and removed when the waiter emits the exit.
        let (registry, mut rx) = PtySessionRegistry::new();
        assert_eq!(registry.sessions.lock().await.len(), 0);

        let response = registry
            .spawn(SpawnRequest {
                command: "/bin/sh".to_string(),
                args: vec!["-c".to_string(), "exit 0".to_string()],
                env: empty_env(),
                cwd: "/tmp".to_string(),
                rows: 24,
                cols: 80,
            })
            .await
            .expect("spawn should succeed");

        // Right after spawn the session is registered.
        assert_eq!(registry.sessions.lock().await.len(), 1);

        // The exit notification proves the waiter ran.
        let _ = drain_until_exit(&mut rx).await;

        // The waiter emits the notification before removing the session, so poll for the removal.
        for _ in 0..20 {
            if registry.sessions.lock().await.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "session {:?} should have been removed from the registry within 1 s of exit",
            response.session_id
        );
    }

    /// Spawning many fast-exiting children and draining every `ExitCodeNotification` leaves the
    /// registry empty.
    ///
    /// `spawn` inserts the handle before starting the reader and waiter, so the waiter's
    /// `map.remove` cannot run before the insert and leak an entry. This is a smoke test, not a
    /// deterministic reproduction: the race window is too narrow to fire reliably, so it catches
    /// gross lifecycle breaks (a waiter that never removes, a spawn that never inserts). It uses
    /// `multi_thread` because production does; the default current-thread test runtime hides the
    /// scheduling shape.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fast_exiting_child_lifecycle_returns_registry_to_zero() {
        let (registry, mut rx) = PtySessionRegistry::new();

        const N: usize = 16;
        let mut session_ids: Vec<String> = Vec::with_capacity(N);
        for _ in 0..N {
            let resp = registry
                .spawn(SpawnRequest {
                    command: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), "exit 0".to_string()],
                    env: empty_env(),
                    cwd: "/tmp".to_string(),
                    rows: 24,
                    cols: 80,
                })
                .await
                .expect("spawn of `sh -c 'exit 0'` should succeed");
            session_ids.push(resp.session_id);
        }

        // Drain until one exit per spawn.
        let mut exits_seen: std::collections::HashSet<String> =
            std::collections::HashSet::with_capacity(N);
        let _ = timeout(Duration::from_secs(10), async {
            while exits_seen.len() < N {
                match rx.recv().await {
                    Some(Envelope::ExitCodeNotification(n)) => {
                        exits_seen.insert(n.session_id);
                    }
                    Some(_) => {}
                    None => return,
                }
            }
        })
        .await;

        assert_eq!(
            exits_seen.len(),
            N,
            "observed only {observed}/{N} ExitCodeNotifications within the 10 s budget — \
             either the waiter task is not firing for every spawn (separate bug) or the \
             envelope-drain loop is starved",
            observed = exits_seen.len()
        );

        // The removal follows the send by microseconds; poll to avoid flakiness.
        // grace window used by `active_session_count_tracks_lifecycle`.
        for _ in 0..40 {
            if registry.sessions.lock().await.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let final_count = registry.sessions.lock().await.len();
        panic!(
            "registry leaked sessions: active session count = {final_count} after every \
             one of {N} fast-exit ExitCodeNotifications was observed. This indicates the \
             spawn/exit lifecycle contract is broken — see `PtySessionRegistry::spawn` for \
             the insert-before-spawn shape that closes the race the bug introduces."
        );
    }
}
