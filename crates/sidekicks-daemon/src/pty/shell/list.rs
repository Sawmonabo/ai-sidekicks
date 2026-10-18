//! Who follows one session's shell list, and the sending of it. Each list is the whole list, read
//! once every holder in it has settled: every follower gets it after a change, and a follower that
//! just joined gets its first one without the others getting anything for the joining. What comes
//! while a list is being read makes one more read, never two at once.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::BoxFuture;
use sidekicks_contracts::terminal::TerminalListUpdate;

use crate::ipc::stream::latest_value::LatestValueOutlet;

/// Reads a session's whole shell list once every holder in it has settled.
pub(crate) type ShellListRead =
    Arc<dyn Fn() -> BoxFuture<'static, TerminalListUpdate> + Send + Sync>;

/// One follower's place among a session's followers, which its feed's detach gives back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ShellListFollowerId(u64);

/// The followers and whether a read is due or running.
struct Followers {
    outlets: HashMap<ShellListFollowerId, LatestValueOutlet<TerminalListUpdate>>,
    /// Followers that joined since the list was last sent and have not had their first one.
    awaiting_first: HashSet<ShellListFollowerId>,
    next_id: u64,
    is_stale: bool,
    is_sending: bool,
}

/// The followers of one session's shell list, each through its own newest-value feed.
#[derive(Clone)]
pub(crate) struct ShellListFollowers {
    followers: Arc<Mutex<Followers>>,
    read_list: ShellListRead,
}

impl ShellListFollowers {
    /// Followers of the list `read_list` reads; nobody follows yet.
    pub(crate) fn new(read_list: ShellListRead) -> Self {
        Self {
            followers: Arc::new(Mutex::new(Followers {
                outlets: HashMap::new(),
                awaiting_first: HashSet::new(),
                next_id: 0,
                is_stale: false,
                is_sending: false,
            })),
            read_list,
        }
    }

    /// How many follow the list.
    pub(crate) fn follower_count(&self) -> usize {
        self.lock().outlets.len()
    }

    /// Sends the whole list through `outlet` now and after every change, until
    /// [`Self::unfollow`] with the id answered, which the feed's detach calls.
    pub(crate) fn follow(
        &self,
        outlet: LatestValueOutlet<TerminalListUpdate>,
    ) -> ShellListFollowerId {
        let id = {
            let mut followers = self.lock();
            let id = ShellListFollowerId(followers.next_id);
            followers.next_id += 1;
            followers.outlets.insert(id, outlet);
            followers.awaiting_first.insert(id);
            id
        };
        self.send();
        id
    }

    /// Stops sending to the follower `id`.
    pub(crate) fn unfollow(&self, id: ShellListFollowerId) {
        let mut followers = self.lock();
        followers.outlets.remove(&id);
        followers.awaiting_first.remove(&id);
    }

    /// Marks the list changed and sends it to every follower.
    pub(crate) fn mark_changed(&self) {
        self.lock().is_stale = true;
        self.send();
    }

    /// Starts the one sending task unless it runs; it reads until nothing is due.
    fn send(&self) {
        {
            let mut followers = self.lock();
            if followers.is_sending {
                return;
            }
            followers.is_sending = true;
        }
        let sender = self.clone();
        tokio::spawn(async move { sender.send_until_current().await });
    }

    /// Reads and sends the list while a change or a new follower waits for it.
    async fn send_until_current(&self) {
        loop {
            let is_changed = {
                let mut followers = self.lock();
                if !followers.is_stale && followers.awaiting_first.is_empty() {
                    followers.is_sending = false;
                    return;
                }
                std::mem::replace(&mut followers.is_stale, false)
            };
            let update = (self.read_list)().await;
            let mut followers = self.lock();
            let recipients: Vec<ShellListFollowerId> = if is_changed {
                followers.outlets.keys().copied().collect()
            } else {
                followers.awaiting_first.iter().copied().collect()
            };
            for id in recipients {
                followers.awaiting_first.remove(&id);
                if let Some(outlet) = followers.outlets.get(&id) {
                    outlet.send(update.clone());
                }
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Followers> {
        self.followers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
