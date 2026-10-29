//! A windowless starter for tests that counts its starts.

use std::process::ExitStatus;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_platforms::WindowlessLaunch;

use crate::attention::banner_launcher::WindowlessAppStarter;

/// Counts the app's starts and hands back a process to watch, which exits at once or never.
pub struct CountingStarter {
    starts: AtomicUsize,
    does_app_exit: bool,
}

impl CountingStarter {
    /// A starter whose started app exits at once, so only a subscription's hold keeps the next
    /// start back.
    pub fn exiting_at_once() -> Self {
        Self {
            starts: AtomicUsize::new(0),
            does_app_exit: true,
        }
    }

    /// A starter whose started app never exits, so no start follows the first.
    pub fn never_exiting() -> Self {
        Self {
            starts: AtomicUsize::new(0),
            does_app_exit: false,
        }
    }

    /// How many starts were made.
    pub fn starts(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }
}

impl WindowlessAppStarter for CountingStarter {
    fn launch_app(&self) -> BoxFuture<'static, std::io::Result<WindowlessLaunch>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let exit = if self.does_app_exit {
            async { Ok(ExitStatus::default()) }.boxed()
        } else {
            std::future::pending().boxed()
        };
        async { Ok(WindowlessLaunch::Watched { exit }) }.boxed()
    }
}
