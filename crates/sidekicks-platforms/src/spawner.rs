//! The daemon's spawner thread: the one long-lived thread every child is started from, so a child
//! never outlives the thread that forked it and a Linux parent-death signal fires only with the
//! daemon.

use std::io;
use std::thread;

use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

/// How many jobs wait for the spawner thread before a caller waits for room.
const JOB_CAPACITY: usize = 64;

/// One job the spawner thread runs.
type Job = Box<dyn FnOnce() + Send>;

/// A handle to the daemon's spawner thread, made once at start and cloned to every crate that
/// starts a child; the thread has the runtime entered, so `tokio::process` spawns there.
#[derive(Clone)]
pub struct Spawner {
    jobs: mpsc::Sender<Job>,
}

impl Spawner {
    /// Starts the spawner thread with `runtime` entered on it. Fails when the thread cannot be
    /// made.
    pub fn new(runtime: Handle) -> io::Result<Self> {
        let (jobs, mut receiver) = mpsc::channel::<Job>(JOB_CAPACITY);
        thread::Builder::new()
            .name("spawner".to_owned())
            .spawn(move || {
                let _runtime = runtime.enter();
                while let Some(job) = receiver.blocking_recv() {
                    job();
                }
            })?;
        Ok(Self { jobs })
    }

    /// Runs `job` on the spawner thread and answers what it returned. Fails when the thread has
    /// ended.
    pub async fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<T> {
        let (answer, answered) = oneshot::channel();
        let job: Job = Box::new(move || {
            if answer.send(job()).is_err() {
                tracing::debug!("a spawner job's caller stopped waiting for its answer");
            }
        });
        self.jobs
            .send(job)
            .await
            .map_err(|_closed| spawner_ended())?;
        answered.await.map_err(|_dropped| spawner_ended())
    }
}

fn spawner_ended() -> io::Error {
    io::Error::other("the spawner thread has ended")
}
