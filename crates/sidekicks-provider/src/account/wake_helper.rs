//! The machine's one wake helper as the account plane reaches it: a wake booked and canceled for
//! an account's window reset, the helper installed when the first account's wake switch turns on
//! and removed when the last one turns off, and its status. The system's helper is
//! [`SystemWakeHelper`], built only where the platforms crate supplies one.

use std::path::PathBuf;
use std::time::SystemTime;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::methods::{
    PROVIDER_WAKE_HELPER_REASON_MAX_LEN, ProviderWakeHelperState,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{Spawner, WakeHelper, WakeHelperError, WakeHelperStatus, WakeReply};
use sidekicks_std::text_cut::cut_to_code_points;

/// The wake helper the window start books its wakes on and the account settings install.
pub trait MachineWakeHelper: Send + Sync {
    /// Books a wake one minute before `asked_at` and answers the helper's reply. Fails when the
    /// helper cannot be reached or answers no reply it writes.
    fn book(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>>;

    /// Cancels the wake booked for `asked_at` and answers the helper's reply. Fails as
    /// [`Self::book`] fails.
    fn cancel(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>>;

    /// Installs the helper behind one administrator prompt. Fails with the prompt's or the step's
    /// cause, [`WakeHelperError::Canceled`] when the person cancels.
    fn install(&self) -> BoxFuture<'_, Result<(), WakeHelperError>>;

    /// Removes the helper behind one administrator prompt. Fails as [`Self::install`] fails.
    fn uninstall(&self) -> BoxFuture<'_, Result<(), WakeHelperError>>;

    /// Whether the helper is installed, turned off in the system's login items, or missing.
    /// Fails when the system's answer cannot be read.
    fn status(&self) -> BoxFuture<'_, Result<WakeHelperStatus, WakeHelperError>>;
}

/// The helper's status as the wire reads it.
pub fn wake_helper_state(status: WakeHelperStatus) -> ProviderWakeHelperState {
    match status {
        WakeHelperStatus::Installed => ProviderWakeHelperState::Installed {},
        WakeHelperStatus::TurnedOff => ProviderWakeHelperState::TurnedOff {},
        WakeHelperStatus::Missing => ProviderWakeHelperState::Missing {},
    }
}

/// A helper that did not install, its reason `error`'s own words, cut to the wire's cap.
pub fn wake_helper_not_installed(error: &WakeHelperError) -> ProviderWakeHelperState {
    let words = error.to_string().replace('\0', " ");
    ProviderWakeHelperState::NotInstalled {
        reason: FreeFormText::new(
            cut_to_code_points(&words, PROVIDER_WAKE_HELPER_REASON_MAX_LEN).to_owned(),
        )
        .expect("an error's words are neither blank nor hold a NUL"),
    }
}

/// The system's wake helper, installed from the helper program the service ships beside it.
pub struct SystemWakeHelper {
    helper: WakeHelper,
    spawner: Spawner,
    helper_program: PathBuf,
}

impl SystemWakeHelper {
    /// The system's `helper`, installed from `helper_program` with `spawner` starting the
    /// administrator prompt.
    pub fn new(helper: WakeHelper, spawner: Spawner, helper_program: PathBuf) -> Self {
        Self {
            helper,
            spawner,
            helper_program,
        }
    }
}

impl MachineWakeHelper for SystemWakeHelper {
    fn book(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>> {
        self.helper.book(asked_at).boxed()
    }

    fn cancel(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>> {
        self.helper.cancel(asked_at).boxed()
    }

    fn install(&self) -> BoxFuture<'_, Result<(), WakeHelperError>> {
        self.helper
            .install(&self.spawner, &self.helper_program)
            .boxed()
    }

    fn uninstall(&self) -> BoxFuture<'_, Result<(), WakeHelperError>> {
        self.helper.uninstall(&self.spawner).boxed()
    }

    fn status(&self) -> BoxFuture<'_, Result<WakeHelperStatus, WakeHelperError>> {
        let helper = self.helper;
        async move {
            // The system's answer blocks, so it is read off the runtime's threads.
            tokio::task::spawn_blocking(move || helper.status())
                .await
                .map_err(|stopped| WakeHelperError::Unreachable(std::io::Error::other(stopped)))?
        }
        .boxed()
    }
}

/// One call a test's wake helper took.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeHelperCall {
    /// A wake booked for this time.
    Book(SystemTime),
    /// The wake booked for this time canceled.
    Cancel(SystemTime),
    /// The helper installed.
    Install,
    /// The helper removed.
    Uninstall,
}

/// A wake helper for tests: it records each call, books and cancels every wake, answers the
/// status it is set to, and installs unless told to refuse.
#[cfg(any(test, feature = "test-support"))]
pub struct ScriptedWakeHelper {
    calls: std::sync::Mutex<Vec<WakeHelperCall>>,
    status: std::sync::Mutex<WakeHelperStatus>,
    is_install_refused: std::sync::atomic::AtomicBool,
}

#[cfg(any(test, feature = "test-support"))]
impl ScriptedWakeHelper {
    /// A helper that reads as `status`.
    pub fn new(status: WakeHelperStatus) -> Self {
        Self {
            calls: std::sync::Mutex::default(),
            status: std::sync::Mutex::new(status),
            is_install_refused: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Every call taken so far, in order.
    pub fn calls(&self) -> Vec<WakeHelperCall> {
        sidekicks_std::mutex_lock::lock(&self.calls).clone()
    }

    /// Has every later install fail as a canceled administrator prompt.
    pub fn refuse_installs(&self) {
        self.is_install_refused
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn record(&self, call: WakeHelperCall) {
        sidekicks_std::mutex_lock::lock(&self.calls).push(call);
    }

    fn set_status(&self, status: WakeHelperStatus) {
        *sidekicks_std::mutex_lock::lock(&self.status) = status;
    }
}

#[cfg(any(test, feature = "test-support"))]
impl MachineWakeHelper for ScriptedWakeHelper {
    fn book(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>> {
        self.record(WakeHelperCall::Book(asked_at));
        async { Ok(WakeReply::Booked) }.boxed()
    }

    fn cancel(&self, asked_at: SystemTime) -> BoxFuture<'_, Result<WakeReply, WakeHelperError>> {
        self.record(WakeHelperCall::Cancel(asked_at));
        async { Ok(WakeReply::Canceled) }.boxed()
    }

    fn install(&self) -> BoxFuture<'_, Result<(), WakeHelperError>> {
        self.record(WakeHelperCall::Install);
        let answer = if self
            .is_install_refused
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            Err(WakeHelperError::Canceled)
        } else {
            self.set_status(WakeHelperStatus::Installed);
            Ok(())
        };
        async move { answer }.boxed()
    }

    fn uninstall(&self) -> BoxFuture<'_, Result<(), WakeHelperError>> {
        self.record(WakeHelperCall::Uninstall);
        self.set_status(WakeHelperStatus::Missing);
        async { Ok(()) }.boxed()
    }

    fn status(&self) -> BoxFuture<'_, Result<WakeHelperStatus, WakeHelperError>> {
        let status = *sidekicks_std::mutex_lock::lock(&self.status);
        async move { Ok(status) }.boxed()
    }
}
