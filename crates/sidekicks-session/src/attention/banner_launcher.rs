//! The app's windowless start for a pending banner: at most one start in flight, none while this
//! machine holds a machine-wide attention subscription, since that app posts the banner itself.

use std::error::Error;
use std::io::{self, ErrorKind};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_platforms::{Spawner, WindowlessLaunch, launch_app_windowless};
use sidekicks_std::mutex_lock::lock;

// How long a start that hands back no process keeps the next one back: three times the slowest
// windowless start measured on macOS (0.21 s), so a started app that ends before it subscribes
// does not keep every later start back.
const UNWATCHED_START_HOLD: Duration = Duration::from_millis(630);

/// What starts the app with no window: the daemon's spawner in the program, a recording starter in
/// tests.
pub trait WindowlessAppStarter: Send + Sync {
    /// Starts the app with no window, answering whether a process came back to watch. Fails as
    /// [`launch_app_windowless`] fails, with `Unsupported` where this system starts no app yet.
    fn launch_app(&self) -> BoxFuture<'static, io::Result<WindowlessLaunch>>;
}

impl WindowlessAppStarter for Spawner {
    fn launch_app(&self) -> BoxFuture<'static, io::Result<WindowlessLaunch>> {
        let spawner = self.clone();
        Box::pin(async move { launch_app_windowless(&spawner).await })
    }
}

/// Starts the app with no window when a decision wrote a pending banner and no app of this machine
/// listens: it counts this machine's open machine-wide attention subscriptions and keeps at most
/// one start in flight.
pub struct BannerLauncher {
    starter: Arc<dyn WindowlessAppStarter>,
    state: Arc<Mutex<LaunchState>>,
}

// What the launcher knows, changed only in short synchronous steps, never across an await.
#[derive(Default)]
struct LaunchState {
    // This machine's open machine-wide attention subscriptions.
    local_subscriptions: usize,
    // The number of the start in flight, which only its own end or a subscription's open lifts.
    in_flight: Option<u64>,
    // How many starts were made, which numbers the next one.
    starts_made: u64,
    // Whether this run of the daemon logged that its system starts no app yet.
    has_logged_unsupported: bool,
}

impl BannerLauncher {
    /// A launcher that starts the app through `starter`, with no subscription open and no start in
    /// flight.
    pub fn new(starter: Arc<dyn WindowlessAppStarter>) -> Self {
        Self {
            starter,
            state: Arc::new(Mutex::new(LaunchState::default())),
        }
    }

    /// Counts a machine-wide attention subscription from this machine until the hold drops, and
    /// lifts the start in flight, since the subscription is what the start was for.
    pub fn hold_local_subscription(&self) -> LocalSubscriptionHold {
        let mut state = lock(&self.state);
        state.local_subscriptions += 1;
        state.in_flight = None;
        drop(state);
        LocalSubscriptionHold {
            state: Arc::clone(&self.state),
        }
    }

    /// Starts the app with no window after a decision wrote a pending banner, unless this machine
    /// holds a machine-wide attention subscription or a start is in flight. A failed start is
    /// logged, never answered: the banner stays pending for the app to post.
    pub fn request_start(&self) {
        let number = {
            let mut state = lock(&self.state);
            if state.local_subscriptions > 0 || state.in_flight.is_some() {
                return;
            }
            state.starts_made += 1;
            state.in_flight = Some(state.starts_made);
            state.starts_made
        };
        let launch = self.starter.launch_app();
        let in_flight = InFlightStart {
            state: Arc::clone(&self.state),
            number,
        };
        tokio::spawn(launch_and_lift(launch, in_flight));
    }
}

/// A machine-wide attention subscription from this machine, counted until it drops.
pub struct LocalSubscriptionHold {
    state: Arc<Mutex<LaunchState>>,
}

impl Drop for LocalSubscriptionHold {
    fn drop(&mut self) {
        lock(&self.state).local_subscriptions -= 1;
    }
}

// A start in flight, lifted when it drops unless a subscription's open lifted it first.
struct InFlightStart {
    state: Arc<Mutex<LaunchState>>,
    number: u64,
}

impl InFlightStart {
    // Whether this is the daemon's first answer that its system starts no app, marking it logged.
    fn is_first_unsupported(&self) -> bool {
        !std::mem::replace(&mut lock(&self.state).has_logged_unsupported, true)
    }
}

impl Drop for InFlightStart {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        if state.in_flight == Some(self.number) {
            state.in_flight = None;
        }
    }
}

// Waits for `launch`, then holds `in_flight` until the started process exits, or with no process
// to watch for the fallback hold; a failed start lifts it at once, since nothing was started.
async fn launch_and_lift(
    launch: BoxFuture<'static, io::Result<WindowlessLaunch>>,
    in_flight: InFlightStart,
) {
    match launch.await {
        Ok(WindowlessLaunch::Unwatched) => tokio::time::sleep(UNWATCHED_START_HOLD).await,
        // Awaited to its end even after a subscription lifted the start, which reaps the process.
        Ok(WindowlessLaunch::Watched { exit }) => {
            if let Err(error) = exit.await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the wait for the app started with no window failed"
                );
            }
        }
        Err(error) if error.kind() == ErrorKind::Unsupported => {
            if in_flight.is_first_unsupported() {
                tracing::info!(
                    error = &error as &(dyn Error + 'static),
                    "this system does not start the app with no window, so a banner waits for the \
                     app"
                );
            }
        }
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the app could not be started with no window, so its banner waits for the app"
        ),
    }
    drop(in_flight);
}

#[cfg(test)]
mod tests {
    use std::future;
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use rstest::rstest;
    use tokio::sync::oneshot;
    use tokio::time::sleep;

    use super::*;

    // What the recording starter hands back from each start.
    #[derive(Clone, Copy)]
    enum Answer {
        Unwatched,
        Watched,
    }

    // Counts each start and hands back `answer`, a watched start's exit held until `exit_all`.
    struct RecordingStarter {
        answer: Answer,
        launches: AtomicUsize,
        exits: Mutex<Vec<oneshot::Sender<()>>>,
    }

    impl RecordingStarter {
        fn launches(&self) -> usize {
            self.launches.load(Ordering::SeqCst)
        }

        fn exit_all(&self) {
            for exited in lock(&self.exits).drain(..) {
                exited
                    .send(())
                    .expect("the start's task waits for its exit");
            }
        }
    }

    impl WindowlessAppStarter for RecordingStarter {
        fn launch_app(&self) -> BoxFuture<'static, io::Result<WindowlessLaunch>> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            let launch = match self.answer {
                Answer::Unwatched => WindowlessLaunch::Unwatched,
                Answer::Watched => {
                    let (exited, exit) = oneshot::channel();
                    lock(&self.exits).push(exited);
                    WindowlessLaunch::Watched {
                        exit: Box::pin(async move {
                            exit.await.map_err(io::Error::other)?;
                            Ok(ExitStatus::default())
                        }),
                    }
                }
            };
            Box::pin(future::ready(Ok(launch)))
        }
    }

    fn launcher_over(answer: Answer) -> (Arc<RecordingStarter>, BannerLauncher) {
        let starter = Arc::new(RecordingStarter {
            answer,
            launches: AtomicUsize::new(0),
            exits: Mutex::new(Vec::new()),
        });
        let launcher = BannerLauncher::new(Arc::clone(&starter) as Arc<dyn WindowlessAppStarter>);
        (starter, launcher)
    }

    // Killed by a launcher that drops the subscriber check.
    #[tokio::test(start_paused = true)]
    async fn a_request_while_a_local_subscription_is_open_starts_nothing() {
        let (starter, launcher) = launcher_over(Answer::Unwatched);
        let _subscription = launcher.hold_local_subscription();

        launcher.request_start();

        assert_eq!(starter.launches(), 0);
    }

    // Killed by a launcher that drops the in-flight guard.
    #[tokio::test(start_paused = true)]
    async fn two_requests_with_none_open_start_once() {
        let (starter, launcher) = launcher_over(Answer::Unwatched);

        launcher.request_start();
        sleep(Duration::from_millis(1)).await;
        launcher.request_start();

        assert_eq!(starter.launches(), 1);
    }

    // What lifts the start in flight.
    enum Lift {
        SubscriptionOpens,
        FallbackPasses,
        ProcessExits,
    }

    // Killed by a guard never lifted: by the subscription's open, by the fallback hold (or one
    // shorter than it), or by the watched process's exit.
    #[rstest]
    #[case::a_subscription_opens(Lift::SubscriptionOpens)]
    #[case::the_fallback_passes(Lift::FallbackPasses)]
    #[case::the_process_exits(Lift::ProcessExits)]
    #[tokio::test(start_paused = true)]
    async fn the_next_request_starts_again_once_the_guard_lifts(#[case] lift: Lift) {
        let answer = match lift {
            Lift::SubscriptionOpens | Lift::FallbackPasses => Answer::Unwatched,
            Lift::ProcessExits => Answer::Watched,
        };
        let (starter, launcher) = launcher_over(answer);
        launcher.request_start();
        // The paused clock moves only once the start's task waits, so its hold began at zero.
        sleep(Duration::from_millis(1)).await;

        match lift {
            Lift::SubscriptionOpens => drop(launcher.hold_local_subscription()),
            Lift::FallbackPasses => {
                sleep(UNWATCHED_START_HOLD - Duration::from_millis(2)).await;
                launcher.request_start();
                assert_eq!(
                    starter.launches(),
                    1,
                    "the guard lifted before the hold passed"
                );
                sleep(Duration::from_millis(2)).await;
            }
            Lift::ProcessExits => {
                launcher.request_start();
                assert_eq!(
                    starter.launches(),
                    1,
                    "the guard lifted before the process exited"
                );
                starter.exit_all();
                sleep(Duration::from_millis(1)).await;
            }
        }
        launcher.request_start();

        assert_eq!(starter.launches(), 2);
    }
}
