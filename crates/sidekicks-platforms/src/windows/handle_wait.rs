//! A wait the system's thread pool runs on a handle, which notifies once the handle is signaled.

use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle as _, OwnedHandle};
use std::ptr;
use std::sync::Arc;

use tokio::sync::Notify;
use tokio::sync::futures::Notified;
use windows_sys::Win32::Foundation::TRUE;
use windows_sys::Win32::System::Threading::{
    CloseThreadpoolWait, CreateThreadpoolWait, PTP_CALLBACK_INSTANCE, PTP_WAIT, SetThreadpoolWait,
    WaitForThreadpoolWaitCallbacks,
};

/// A thread-pool wait on a handle it holds a share of, set by [`HandleWait::new`] and each
/// [`HandleWait::set`] to notify once at the handle's next signal; the drop ends the wait and its
/// callbacks before its share of the handle lets the handle close.
pub(crate) struct HandleWait {
    // An integer in the bindings, so the type is `Send` and `Sync` by itself, which holds: the
    // pool's calls take the wait from any thread, and the callback reads only the `Notify`.
    wait: PTP_WAIT,
    handle: Arc<OwnedHandle>,
    signaled: Arc<Notify>,
}

impl HandleWait {
    /// A wait on `handle`, set. Fails with the system's error when the pool refuses the wait.
    pub(crate) fn new(handle: Arc<OwnedHandle>) -> io::Result<Self> {
        let signaled = Arc::new(Notify::new());
        // SAFETY: the callback matches `PTP_WAIT_CALLBACK`, and its context is `signaled`, which
        // the wait holds until its drop has waited out every callback; no environment means the
        // default pool.
        let wait = unsafe {
            CreateThreadpoolWait(
                Some(notify_signaled),
                Arc::as_ptr(&signaled).cast_mut().cast(),
                ptr::null(),
            )
        };
        if wait == 0 {
            return Err(io::Error::last_os_error());
        }
        let handle_wait = Self {
            wait,
            handle,
            signaled,
        };
        handle_wait.set();
        Ok(handle_wait)
    }

    /// Sets the wait on its handle again, in place of any set before; a wait that notified must
    /// be set again before the handle's next signal.
    pub(crate) fn set(&self) {
        // SAFETY: the wait is live and its handle stays open while the wait holds its share; no
        // timeout.
        unsafe { SetThreadpoolWait(self.wait, self.handle.as_raw_handle(), ptr::null()) };
    }

    /// Completes at the next notification, at once for one no one waited for. Cancel-safe.
    pub(crate) fn notified(&self) -> Notified<'_> {
        self.signaled.notified()
    }
}

impl Drop for HandleWait {
    fn drop(&mut self) {
        // SAFETY: the wait is live and ended here once: a null handle stops new callbacks, the
        // wait cancels queued ones and returns once a running one has, and the close frees it, so
        // no callback reads `signaled` or waits on the handle after.
        unsafe {
            SetThreadpoolWait(self.wait, ptr::null_mut(), ptr::null());
            WaitForThreadpoolWaitCallbacks(self.wait, TRUE);
            CloseThreadpoolWait(self.wait);
        }
    }
}

// The wait's callback: notifies that the handle was signaled.
unsafe extern "system" fn notify_signaled(
    _instance: PTP_CALLBACK_INSTANCE,
    context: *mut c_void,
    _wait: PTP_WAIT,
    _wait_result: u32,
) {
    // SAFETY: the context is the wait's `Notify`, alive until its drop has waited out callbacks.
    unsafe { (*context.cast::<Notify>()).notify_one() };
}
