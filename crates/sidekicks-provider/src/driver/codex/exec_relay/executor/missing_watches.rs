//! The executor's one missing-path watch, which every connection's `fs/watchMissing` joins. The
//! executor keeps one watch per connection and the relay is its one connection, so the relay keeps
//! each connection's observation and sends the union of them all under watch ids of its own. A
//! fire of the current union reaches each watcher under its own watch id; a declined union is
//! answered to its joiner and the others are watched again, or told once they cannot be.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;

use super::{CodexExecutor, RelayConnectionId};
use crate::driver::codex::exec_relay::executor_end::compose_executor_ended_answer;
use crate::driver::codex::exec_relay::message::RoutedParams;
use crate::driver::codex::exec_relay::methods::{
    FS_MISSING_CHANGED_METHOD, FS_WATCH_MISSING_METHOD,
};

/// Every connection's observation and the union the executor watches for them.
#[derive(Default)]
pub(super) struct MissingWatches {
    table: Mutex<WatchTable>,
    // Serializes the joins: the executor declines a register while another runs, and each one
    // must carry a higher watch id than the last.
    joining: tokio::sync::Mutex<()>,
}

impl MissingWatches {
    /// Forgets `connection`'s observation, which went away; the union stays armed until its fire
    /// or the next join narrows it.
    pub(super) fn forget_connection(&self, connection: RelayConnectionId) {
        lock(&self.table).observations.remove(&connection);
    }
}

// Each connection's one observation, the relay's watch id of the union sent last, and the next
// one to mint.
struct WatchTable {
    observations: HashMap<RelayConnectionId, MissingObservation>,
    union_watch_id: Option<u64>,
    next_watch_id: u64,
}

impl Default for WatchTable {
    fn default() -> Self {
        Self {
            observations: HashMap::new(),
            union_watch_id: None,
            next_watch_id: 1,
        }
    }
}

impl WatchTable {
    // Takes every kept watcher out and forgets the union, whose watch is spent or gone.
    fn take_watchers(&mut self) -> Vec<(RelayConnectionId, MissingObservation)> {
        self.union_watch_id = None;
        self.observations.drain().collect()
    }

    // The one `present` path the kept observations name.
    fn present(&self) -> Option<&Value> {
        self.observations
            .values()
            .find_map(|observation| observation.present.as_ref())
    }

    // The params of the union of every kept observation and `joiner`'s under a newly minted watch
    // id, which becomes the union's, each path once.
    fn send_union(&mut self, joiner: Option<&MissingObservation>) -> (u64, Value) {
        let watch_id = self.next_watch_id;
        self.next_watch_id += 1;
        self.union_watch_id = Some(watch_id);
        let observations: Vec<&MissingObservation> =
            self.observations.values().chain(joiner).collect();
        let mut missing: Vec<&Value> = Vec::new();
        for path in observations
            .iter()
            .flat_map(|observation| &observation.missing)
        {
            if !missing.contains(&path) {
                missing.push(path);
            }
        }
        let present = observations
            .iter()
            .find_map(|observation| observation.present.as_ref());
        let params = json!({ "watchId": watch_id, "missing": missing, "present": present });
        (watch_id, params)
    }
}

// One connection's watch: its own watch id, the paths it waits to see appear and the one path it
// waits to stay, as the connection sent them.
struct MissingObservation {
    own_watch_id: u64,
    missing: Vec<Value>,
    present: Option<Value>,
}

impl MissingObservation {
    // The watch `params` asks for; `None` for one with no watch id or no list of paths.
    fn read(params: &RoutedParams<'_>) -> Option<Self> {
        Some(Self {
            own_watch_id: params.watch_id?,
            missing: serde_json::from_str(params.missing?.get()).ok()?,
            present: params
                .present
                .map(|present| serde_json::from_str(present.get()))
                .transpose()
                .ok()?,
        })
    }
}

// The executor's answer to a watch.
#[derive(Deserialize)]
struct WatchAnswer {
    watching: bool,
}

impl CodexExecutor {
    /// The join of `connection`'s `fs/watchMissing`, sent under `id` with `params`, into the
    /// executor's one watch, for the caller to run on a task of its own. The joiner is answered
    /// `watching` as the union's register is, and `false` when it names another `present` than
    /// the union's, which sends nothing.
    pub(in crate::driver::codex::exec_relay) fn join_missing_watch(
        self: &Arc<Self>,
        connection: RelayConnectionId,
        id: &RawValue,
        params: Option<&RoutedParams<'_>>,
    ) -> impl Future<Output = ()> + Send + 'static {
        let executor = Arc::clone(self);
        let id = id.to_owned();
        let observation = params.and_then(MissingObservation::read);
        async move { executor.join_union(connection, &id, observation).await }
    }

    /// Hands the fire of the executor's watch `watch_id` to each kept watcher under its own watch
    /// id, the watch being spent; a superseded union's fire reaches no one.
    pub(super) fn fire_missing_watch(&self, watch_id: Option<u64>) {
        let fired: Vec<_> = {
            let mut table = lock(&self.missing_watches.table);
            if watch_id.is_none() || table.union_watch_id != watch_id {
                tracing::debug!(?watch_id, "a superseded Codex missing watch fired");
                return;
            }
            table.take_watchers()
        };
        self.tell_watchers_changed(fired);
    }

    /// Tells every kept watcher its watch changed and forgets the union, the executor having
    /// ended, so nothing watches it any more.
    pub(super) fn fire_every_missing_watch(&self) {
        let fired = lock(&self.missing_watches.table).take_watchers();
        self.tell_watchers_changed(fired);
    }

    fn tell_watchers_changed(&self, watchers: Vec<(RelayConnectionId, MissingObservation)>) {
        for (connection, observation) in watchers {
            self.tell_missing_changed(connection, observation.own_watch_id);
        }
    }

    // Joins `observation` into the union for `connection`, answering its request `id`: once the
    // executor ended, with the error naming the end, as every other request is.
    async fn join_union(
        &self,
        connection: RelayConnectionId,
        id: &RawValue,
        observation: Option<MissingObservation>,
    ) {
        let _joining = self.missing_watches.joining.lock().await;
        if *self.ended.borrow() {
            self.answer_connection(connection, compose_executor_ended_answer(id.get()));
            return;
        }
        let union = {
            let mut table = lock(&self.missing_watches.table);
            // A newer watch supersedes the connection's earlier one, declined or not.
            table.observations.remove(&connection);
            observation
                .filter(|joiner| {
                    let present = table.present();
                    present.is_none()
                        || joiner.present.is_none()
                        || present == joiner.present.as_ref()
                })
                .map(|joiner| (table.send_union(Some(&joiner)), joiner))
        };
        let Some(((watch_id, params), joiner)) = union else {
            self.answer_watching(connection, id, false);
            return;
        };
        if !self.register_missing_watch(&params).await {
            // The end's settle fired every kept watcher; this one is answered as a later request.
            if *self.ended.borrow() {
                self.answer_connection(connection, compose_executor_ended_answer(id.get()));
                return;
            }
            self.answer_watching(connection, id, false);
            self.restore_missing_watch().await;
            return;
        }
        let own_watch_id = joiner.own_watch_id;
        let is_armed = {
            let mut table = lock(&self.missing_watches.table);
            let is_armed = table.union_watch_id == Some(watch_id);
            if is_armed && lock(&self.clients).contains_key(&connection) {
                table.observations.insert(connection, joiner);
            }
            is_armed
        };
        self.answer_watching(connection, id, true);
        // A fire that came ahead of the answer spent the union before the joiner was kept.
        if !is_armed {
            self.tell_missing_changed(connection, own_watch_id);
        }
    }

    // Sends the kept observations again after a declined union; when that is declined too, each
    // watcher is told its watch changed, since nothing watches it any more.
    async fn restore_missing_watch(&self) {
        let union = {
            let mut table = lock(&self.missing_watches.table);
            (!table.observations.is_empty()).then(|| table.send_union(None))
        };
        let Some((_watch_id, params)) = union else {
            return;
        };
        if self.register_missing_watch(&params).await {
            return;
        }
        let unwatched = lock(&self.missing_watches.table).take_watchers();
        self.tell_watchers_changed(unwatched);
    }

    // Registers the union `params` and answers whether the executor watches it; it waits with no
    // bound, as Codex's own call does, and fails with the executor's end.
    async fn register_missing_watch(&self, params: &Value) -> bool {
        match self
            .request_within(FS_WATCH_MISSING_METHOD, params, None::<Duration>)
            .await
        {
            Ok(result) => result
                .and_then(|result| serde_json::from_str::<WatchAnswer>(result.get()).ok())
                .is_some_and(|answer| answer.watching),
            Err(error) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex executor's missing watch could not be registered"
                );
                false
            }
        }
    }

    // Answers `connection`'s watch request `id` with `is_watching`.
    fn answer_watching(&self, connection: RelayConnectionId, id: &RawValue, is_watching: bool) {
        let answer = format!(
            "{{\"id\":{},\"result\":{{\"watching\":{is_watching}}}}}",
            id.get()
        );
        self.answer_connection(connection, answer);
    }

    // Tells `connection` its watch `own_watch_id` changed.
    fn tell_missing_changed(&self, connection: RelayConnectionId, own_watch_id: u64) {
        let changed = json!({
            "method": FS_MISSING_CHANGED_METHOD,
            "params": { "watchId": own_watch_id },
        });
        self.answer_connection(connection, changed.to_string());
    }
}
