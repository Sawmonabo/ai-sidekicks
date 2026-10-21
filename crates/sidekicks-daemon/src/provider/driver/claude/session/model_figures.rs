//! Claude Code's figures that no session request returns: a model's context window and reply
//! reserve, and the style and advisor choices a session's folder and account offer. Each is read
//! in a short control-only process, so it is held for the daemon's life and read once per key of
//! one installed build; a new build starts an empty store, since a build can change every figure.
//! - A window and a reply reserve are keyed by the model and the API endpoint the process was
//!   given, the provider it was switched to and that provider's base address, since another
//!   provider or a proxy changes both.
//! - Style and advisor choices are keyed by the session's folder, whose own styles are listed, and
//!   its config folder, whose sign-in decides the advisors.
//!
//! A read in flight is shared: sessions created together wait on one process, which runs to its
//! end even when every waiter is gone, and a failed read is dropped so the next session reads
//! again, whether a waiter saw it fail or none was left to. The store holds one entry per folder
//! and config home and one per endpoint and model: tens of entries of a few hundred bytes over the
//! daemon's life, never evicted.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_platforms::PathRules;

use crate::provider::driver::claude::session::answered_commands::ClaudeCommandChoices;
use crate::provider::driver::claude::session::reply_reserve::{
    ClaudeReplyReserve, read_context_reply,
};
use crate::provider::driver::claude::session::transport::readings::{
    ClaudeModelContextRead, ClaudeSessionFolderReadRequest,
};
use crate::provider::driver::claude::spawn::environment::claude_config_folder;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::record_readers::{read_count, read_non_empty_string};

/// The variables that point Claude Code at an API endpoint other than its default: the switch to
/// each provider it reaches besides Anthropic's own API, then each provider's base address.
const CLAUDE_ENDPOINT_VARIABLES: [&str; 11] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
];

/// A figure read every waiter shares: its process's result, a failure shared whole.
pub(crate) type ClaudeFigureResult<T> = Result<T, Arc<ClaudeLaunchError>>;

// A read in flight or done, cloned by each waiter.
type SharedRead<T> = Shared<BoxFuture<'static, ClaudeFigureResult<T>>>;

// The reads held under one kind of key.
type HeldReads<K, T> = Arc<Mutex<HashMap<K, SharedRead<T>>>>;

/// The endpoint a process sends its requests to: the value each endpoint variable has in its
/// environment, in [`CLAUDE_ENDPOINT_VARIABLES`]' order; all `None` is Claude Code's default.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ClaudeEndpoint(Vec<Option<String>>);

impl ClaudeEndpoint {
    fn of(spawn_environment: &[(String, String)], rules: PathRules) -> Self {
        Self(
            CLAUDE_ENDPOINT_VARIABLES
                .iter()
                .map(|name| {
                    rules
                        .environment_value(spawn_environment, name)
                        .map(str::to_owned)
                })
                .collect(),
        )
    }
}

/// A model at an endpoint, which a window and a reply reserve are read for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ClaudeModelKey {
    endpoint: ClaudeEndpoint,
    model: String,
}

/// A session's folder and the config folder its process reads, which its choices are read for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ClaudeChoicesKey {
    working_directory: PathBuf,
    config_folder: Option<PathBuf>,
}

/// The context reads made against one endpoint.
#[derive(Default)]
struct EndpointContextReads {
    context_windows: HashMap<String, u64>,
    // Each model a read was asked for or answered for, a refused one included.
    read_models: HashSet<String>,
}

/// The figures held for one installed Claude Code build.
pub(crate) struct ClaudeModelFigures {
    /// The build version these figures describe; `None` before the daemon reads one.
    pub(crate) build_version: Option<String>,
    rules: PathRules,
    command_choices: HeldReads<ClaudeChoicesKey, ClaudeCommandChoices>,
    reply_reserves: HeldReads<ClaudeModelKey, ClaudeReplyReserve>,
    context_reads: Mutex<HashMap<ClaudeEndpoint, EndpointContextReads>>,
}

impl ClaudeModelFigures {
    /// An empty store for the build `build_version`, whose processes run in a place that spells
    /// paths and environment names by `rules`.
    pub(crate) fn new(build_version: Option<String>, rules: PathRules) -> Self {
        Self {
            build_version,
            rules,
            command_choices: Arc::default(),
            reply_reserves: Arc::default(),
            context_reads: Mutex::default(),
        }
    }

    /// The style and advisor choices of `place`'s folder and config folder: the held read's
    /// result, else `read`'s, which runs once however many sessions wait on it. Fails with the
    /// read's failure, shared with every waiter, and then forgets it.
    pub(crate) async fn command_choices<Read>(
        &self,
        place: &ClaudeSessionFolderReadRequest,
        read: impl FnOnce() -> Read,
    ) -> ClaudeFigureResult<ClaudeCommandChoices>
    where
        Read: Future<Output = ClaudeFigureResult<ClaudeCommandChoices>> + Send + 'static,
    {
        let key = ClaudeChoicesKey {
            working_directory: place.working_directory.clone(),
            config_folder: claude_config_folder(&place.spawn_environment, self.rules),
        };
        read_once(&self.command_choices, key, read).await
    }

    /// The reply reserve of `place`'s model at its endpoint, read as
    /// [`command_choices`](Self::command_choices) reads.
    pub(crate) async fn reply_reserve<Read>(
        &self,
        place: &ClaudeSessionFolderReadRequest,
        read: impl FnOnce() -> Read,
    ) -> ClaudeFigureResult<ClaudeReplyReserve>
    where
        Read: Future<Output = ClaudeFigureResult<ClaudeReplyReserve>> + Send + 'static,
    {
        let key = ClaudeModelKey {
            endpoint: ClaudeEndpoint::of(&place.spawn_environment, self.rules),
            model: place.model.clone(),
        };
        read_once(&self.reply_reserves, key, read).await
    }

    /// The context window read for a catalog row's model id at the endpoint `spawn_environment`
    /// sets, in tokens; `None` until a read lands.
    pub(crate) fn context_window_of(
        &self,
        spawn_environment: &[(String, String)],
        model: &str,
    ) -> Option<u64> {
        lock(&self.context_reads)
            .get(&ClaudeEndpoint::of(spawn_environment, self.rules))?
            .context_windows
            .get(model)
            .copied()
    }

    /// Every model whose context read at that endpoint is done, for the next read to skip.
    pub(crate) fn context_read_models(
        &self,
        spawn_environment: &[(String, String)],
    ) -> HashSet<String> {
        lock(&self.context_reads)
            .get(&ClaudeEndpoint::of(spawn_environment, self.rules))
            .map(|reads| reads.read_models.clone())
            .unwrap_or_default()
    }

    /// Records the context reads one process started in `spawn_environment` made; a refused or
    /// unreadable one keeps no window.
    pub(crate) fn record_context_reads(
        &self,
        spawn_environment: &[(String, String)],
        reads: Vec<ClaudeModelContextRead>,
    ) {
        let endpoint = ClaudeEndpoint::of(spawn_environment, self.rules);
        let mut context_reads = lock(&self.context_reads);
        let endpoint_reads = context_reads.entry(endpoint).or_default();
        for read in reads {
            if let Some(model) = read.requested_model {
                endpoint_reads.read_models.insert(model);
            }
            let usage = read_context_reply(read.usage.as_deref());
            // The model the reply names and its whole window; a reply lacking either keeps none.
            if let (Some(model), Some(window)) = (
                read_non_empty_string(&usage, "model"),
                read_count(&usage, "rawMaxTokens").filter(|window| *window > 0),
            ) {
                endpoint_reads.read_models.insert(model.to_owned());
                endpoint_reads
                    .context_windows
                    .insert(model.to_owned(), window);
            }
        }
    }
}

// The held read of `key`, else `read` started in its own task, so it runs to its end with no
// waiter left. A held read that already failed counts as none, so a new read replaces it even when
// no waiter saw the failure; a failed read is also forgotten by the waiter that sees it, and only
// while it is still the one held, so a later read in its place stays.
async fn read_once<K, T, Read>(
    held: &HeldReads<K, T>,
    key: K,
    read: impl FnOnce() -> Read,
) -> ClaudeFigureResult<T>
where
    K: Clone + Eq + Hash,
    T: Clone + Send + Sync + 'static,
    Read: Future<Output = ClaudeFigureResult<T>> + Send + 'static,
{
    let shared = {
        let mut reads = lock(held);
        let live_read = reads.get(&key).filter(|held_read| {
            // Polled once without waiting: a finished read answers at once, and `unconstrained`
            // keeps tokio's task budget from making it look unfinished.
            !matches!(
                tokio::task::unconstrained((*held_read).clone()).now_or_never(),
                Some(Err(_))
            )
        });
        if let Some(shared) = live_read {
            shared.clone()
        } else {
            let task = tokio::spawn(read());
            let shared = async move {
                task.await
                    .expect("a figure read is never aborted, and a panic ends the daemon")
            }
            .boxed()
            .shared();
            reads.insert(key.clone(), shared.clone());
            shared
        }
    };
    let result = shared.clone().await;
    if result.is_err() {
        let mut reads = lock(held);
        if reads
            .get(&key)
            .is_some_and(|held_read| held_read.ptr_eq(&shared))
        {
            reads.remove(&key);
        }
    }
    result
}

fn lock<V>(held: &Mutex<V>) -> MutexGuard<'_, V> {
    held.lock()
        .expect("a figure store's lock is never held across a panic")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use sidekicks_platforms::PathRules;
    use tokio::sync::oneshot;

    use super::ClaudeModelFigures;
    use crate::provider::driver::claude::session::errors::{
        ClaudeSessionError, ClaudeUnansweredCause,
    };
    use crate::provider::driver::claude::session::reply_reserve::ClaudeReplyReserve;
    use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
    use crate::provider::driver::claude::session::transport::readings::ClaudeSessionFolderReadRequest;
    use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;

    fn place() -> ClaudeSessionFolderReadRequest {
        ClaudeSessionFolderReadRequest {
            spawn_environment: Vec::new(),
            working_directory: PathBuf::from("/work"),
            model: "claude-opus-5".to_owned(),
        }
    }

    fn unanswered() -> Arc<ClaudeLaunchError> {
        Arc::new(
            ClaudeSessionError::Unanswered {
                subtype: ClaudeControlSubtype::GetContextUsage,
                cause: ClaudeUnansweredCause::Deadline,
            }
            .into(),
        )
    }

    fn reserve() -> ClaudeReplyReserve {
        ClaudeReplyReserve::Unread {
            reason: "read".to_owned(),
        }
    }

    // Killed by a per-caller read (`OnceCell`'s retry shape: two reads), and by keeping a failed
    // read held (the third call would see the old failure and make no read).
    #[tokio::test]
    async fn concurrent_callers_share_one_read_and_a_failure_is_read_again() {
        let figures = ClaudeModelFigures::new(None, PathRules::Posix);
        let reads = Arc::new(AtomicUsize::new(0));
        let failing_read = || {
            let reads = Arc::clone(&reads);
            move || async move {
                reads.fetch_add(1, Ordering::SeqCst);
                Err(unanswered())
            }
        };
        let place = place();

        let (first, second) = tokio::join!(
            figures.reply_reserve(&place, failing_read()),
            figures.reply_reserve(&place, failing_read()),
        );

        let (Err(first), Err(second)) = (first, second) else {
            panic!("both callers see the failure");
        };
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let third = figures.reply_reserve(&place, failing_read()).await;
        assert!(third.is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    // Killed by a read not run in its own task: with every caller gone, nothing would poll it.
    #[tokio::test(start_paused = true)]
    async fn a_read_every_caller_dropped_still_finishes_for_the_next_caller() {
        let figures = ClaudeModelFigures::new(None, PathRules::Posix);
        let (release, released) = oneshot::channel::<()>();
        let (finish, finished) = oneshot::channel::<()>();
        let place = place();
        let mut first = Box::pin(figures.reply_reserve(&place, move || async move {
            released.await.expect("the test releases the read");
            finish.send(()).expect("the test waits for the read");
            Ok(reserve())
        }));
        assert!(futures::poll!(&mut first).is_pending());
        drop(first);

        release.send(()).expect("the read is waiting");
        tokio::time::timeout(Duration::from_secs(60), finished)
            .await
            .expect("the read finishes with no caller left")
            .expect("the read sends when it finishes");

        let next = figures
            .reply_reserve(&place, || async { panic!("the held read answers") })
            .await;
        assert_eq!(next.ok(), Some(reserve()));
    }

    // Killed by answering a held read that failed with no waiter left to forget it: the next
    // caller would get the old failure and make no read.
    #[tokio::test]
    async fn a_read_that_failed_with_no_caller_left_is_read_again() {
        let figures = ClaudeModelFigures::new(None, PathRules::Posix);
        let (release, released) = oneshot::channel::<()>();
        let (finish, finished) = oneshot::channel::<()>();
        let place = place();
        let mut first = Box::pin(figures.reply_reserve(&place, move || async move {
            released.await.expect("the test releases the read");
            finish.send(()).expect("the test waits for the read");
            Err(unanswered())
        }));
        assert!(futures::poll!(&mut first).is_pending());
        drop(first);
        release.send(()).expect("the read is waiting");
        finished.await.expect("the read sends as it fails");

        let next = figures
            .reply_reserve(&place, || async { Ok(reserve()) })
            .await;

        assert_eq!(next.ok(), Some(reserve()));
    }
}
