//! Every connection's missing-path watch joined into the executor's one: sent under the relay's
//! own watch ids, each fire reaching every watcher under its own id, and a declined union
//! answered to its joiner while the others are watched again or told.

use rstest::rstest;
use serde_json::{Value, json};

use super::{
    ClientSocket, FakeExecutor, ListeningRelay, admitted_socket, assert_executor_quiet,
    assert_quiet, initialize, listening_relay, next_forwarded, next_text, send_text,
};
use crate::driver::test_registry::new_session_id;

const FIRST_PATH: &str = "file:///work/one/.git";
const SECOND_PATH: &str = "file:///work/two/.git";
const PRESENT: &str = "file:///work/one";
const OTHER_PRESENT: &str = "file:///work/two";

// Two connections each watch one path under their own watch id 1; the executor reads the first
// alone and then the union of both under a higher relay id. A fire of the superseded union reaches
// no one, and the current union's fire reaches each connection once under its own id. Killed by
// the client's watch forwarded as it came, by a fire sent under the relay's id, by a fire sent to
// one watcher, and by a superseded union's fire passed on.
#[tokio::test]
async fn missing_watches_join_one_union_and_a_fire_reaches_each_under_its_own_id() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut sockets = [
        admitted_socket(&url, &presented).await,
        admitted_socket(&url, &presented).await,
    ];
    for socket in &mut sockets {
        initialize(socket).await;
    }
    let first_union = join(&mut sockets[0], &mut fake, FIRST_PATH, None).await;
    assert_union(&first_union, &[FIRST_PATH], None);
    answer_watching(&mut fake, &first_union, true).await;
    assert_eq!(next_text(&mut sockets[0]).await, watching(true));
    let second_union = join(&mut sockets[1], &mut fake, SECOND_PATH, None).await;
    assert_union(&second_union, &[FIRST_PATH, SECOND_PATH], None);
    assert!(watch_id(&second_union) > watch_id(&first_union));
    answer_watching(&mut fake, &second_union, true).await;
    assert_eq!(next_text(&mut sockets[1]).await, watching(true));

    fake.write(&changed(watch_id(&first_union))).await;
    for socket in &mut sockets {
        assert_quiet(socket).await;
    }
    fake.write(&changed(watch_id(&second_union))).await;
    for socket in &mut sockets {
        assert_eq!(next_text(socket).await, changed(1));
        assert_quiet(socket).await;
    }
}

// How the executor and the second joiner meet the first connection's watch.
#[derive(Clone, Copy, Debug)]
enum SecondJoin {
    // The union is declined and the first's watch is restored.
    Declined,
    // The union is declined and so is the restore.
    RestoreDeclined,
    // The second names another `present`, which the relay answers itself.
    SecondPresent,
}

// The first connection watches one path with `present`; the second's join is declined. Killed by
// no restore (no third watch, and its fire reaches no one), by a declined restore that tells no
// one (the first reads no fire), and by a second `present` sent on (a union naming it).
#[rstest]
#[tokio::test]
async fn a_declined_union_answers_the_joiner_false_and_watches_the_rest_again(
    #[values(
        SecondJoin::Declined,
        SecondJoin::RestoreDeclined,
        SecondJoin::SecondPresent
    )]
    second_join: SecondJoin,
) {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut first = admitted_socket(&url, &presented).await;
    let mut second = admitted_socket(&url, &presented).await;
    initialize(&mut first).await;
    initialize(&mut second).await;
    let first_union = join(&mut first, &mut fake, FIRST_PATH, Some(PRESENT)).await;
    answer_watching(&mut fake, &first_union, true).await;
    assert_eq!(next_text(&mut first).await, watching(true));

    if let SecondJoin::SecondPresent = second_join {
        send_text(
            &mut second,
            &watch_missing(SECOND_PATH, Some(OTHER_PRESENT)),
        )
        .await;
        assert_eq!(next_text(&mut second).await, watching(false));
        assert_executor_quiet(&mut fake).await;
        fake.write(&changed(watch_id(&first_union))).await;
        assert_eq!(next_text(&mut first).await, changed(1));
        assert_quiet(&mut second).await;
        return;
    }
    let declined = join(&mut second, &mut fake, SECOND_PATH, None).await;
    assert_union(&declined, &[FIRST_PATH, SECOND_PATH], Some(PRESENT));
    answer_watching(&mut fake, &declined, false).await;
    let restore = next_forwarded(&mut fake).await;
    assert_union(&restore, &[FIRST_PATH], Some(PRESENT));
    assert!(watch_id(&restore) > watch_id(&declined));
    let is_restored = matches!(second_join, SecondJoin::Declined);
    answer_watching(&mut fake, &restore, is_restored).await;
    assert_eq!(next_text(&mut second).await, watching(false));
    if is_restored {
        fake.write(&changed(watch_id(&restore))).await;
    }
    assert_eq!(next_text(&mut first).await, changed(1));
    assert_quiet(&mut second).await;
}

// Sends `socket`'s watch of `path` under its own watch id 1 and returns the union the executor
// reads for it.
async fn join(
    socket: &mut ClientSocket,
    fake: &mut FakeExecutor,
    path: &str,
    present: Option<&str>,
) -> Value {
    send_text(socket, &watch_missing(path, present)).await;
    next_forwarded(fake).await
}

// Fails unless `union` is the relay's own watch of exactly `paths`, in any order, and `present`.
fn assert_union(union: &Value, paths: &[&str], present: Option<&str>) {
    assert_eq!(union["method"], "fs/watchMissing", "{union}");
    assert!(
        union["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("sidekicks-relay-")),
        "{union}"
    );
    let mut missing: Vec<&str> = union["params"]["missing"]
        .as_array()
        .expect("a list of paths")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    missing.sort_unstable();
    let mut expected = paths.to_vec();
    expected.sort_unstable();
    assert_eq!(missing, expected, "{union}");
    assert_eq!(union["params"]["present"], json!(present), "{union}");
}

// The relay's watch id in the forwarded `union`.
fn watch_id(union: &Value) -> u64 {
    union["params"]["watchId"]
        .as_u64()
        .expect("a watch id is a number")
}

// Answers the forwarded `union` as the executor does.
async fn answer_watching(fake: &mut FakeExecutor, union: &Value, is_watching: bool) {
    fake.write(&json!({ "id": union["id"], "result": { "watching": is_watching } }))
        .await;
}

// A client's `fs/watchMissing` of `path` under request id 2 and its own watch id 1.
fn watch_missing(path: &str, present: Option<&str>) -> Value {
    json!({ "id": 2, "method": "fs/watchMissing", "params": {
        "watchId": 1,
        "missing": [path],
        "present": present,
    }})
}

// The answer a client reads to its watch.
fn watching(is_watching: bool) -> Value {
    json!({ "id": 2, "result": { "watching": is_watching } })
}

// The executor's fire of the watch `watch_id`.
fn changed(watch_id: u64) -> Value {
    json!({ "method": "fs/missingChanged", "params": { "watchId": watch_id } })
}
