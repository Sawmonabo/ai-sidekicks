//! The daemon's credential store over a stand-in for the keychain tool: what reaches the tool's
//! command line, a locked keychain's reading, and a call ended past its bound.

use secrecy::{ExposeSecret as _, SecretString};

use crate::test_program::harness_test_name;
use crate::{CredentialStore, StandInKeychain, run_keychain_tool_stand_in};

const SERVICE: &str = "ai-sidekicks-workflow-secrets-1a2b3c4d";

// The test whose body is the keychain tool's stand-in.
const STAND_IN_TEST: &str = "the_keychain_tool_stand_in";

// A stand-in keychain answering as `switches` say, and the store over it.
fn stand_in_store(switches: &[&str]) -> (StandInKeychain, CredentialStore) {
    let keychain =
        StandInKeychain::new(&harness_test_name(module_path!(), STAND_IN_TEST), switches);
    let store = keychain
        .credential_store()
        .expect("macOS keeps the store in the keychain");
    (keychain, store)
}

/// Every write sends its value only on the tool's standard input, one `security -i` line, a value
/// larger than one entry as pieces: no call's words hold the value or its hex. An item already
/// there is updated in place, and each value reads back whole. Mutations: the value as an
/// argument (`-w` or `-X` on the command line); the add sent without `-U`.
#[test]
fn a_write_sends_the_secret_only_on_the_tools_input() {
    let (keychain, store) = stand_in_store(&[]);
    let first = "first-secret-value";
    let second = "second-secret-value";
    let long = "long-secret-".repeat(400);

    store
        .write(SERVICE, "account", &SecretString::from(first))
        .expect("the item is added");
    assert_eq!(
        keychain.calls(),
        [vec!["-i".to_owned()], vec!["dump-keychain".to_owned()]]
    );
    store
        .write(SERVICE, "account", &SecretString::from(second))
        .expect("the item is updated");
    store
        .write(SERVICE, "pieced", &SecretString::from(long.as_str()))
        .expect("the long item is written in pieces");

    assert_eq!(
        keychain.item(SERVICE, "account"),
        Some(second.as_bytes().to_vec())
    );
    for (account, value) in [("account", second), ("pieced", long.as_str())] {
        let read = store
            .read(SERVICE, account)
            .expect("the item reads")
            .expect("the item is there");
        assert_eq!(read.expose_secret(), value, "{account}");
    }
    for call in keychain.calls() {
        for word in &call {
            // The service name holds "-w" in "-workflow", so an option is matched as a whole word.
            assert!(word != "-X" && word != "-w", "{call:?}");
            for value in [first, second, "long-secret"] {
                let hex = base16ct::lower::encode_string(value.as_bytes());
                assert!(!word.contains(value) && !word.contains(&hex), "{call:?}");
            }
        }
    }
}

/// A keychain the tool answers as locked reads as locked, which the person is told to unlock,
/// and the next call is served. Mutation: read the tool's refusal as a store that cannot be used.
#[test]
fn a_locked_keychain_reads_locked() {
    let (keychain, store) = stand_in_store(&["locked-once:held"]);
    keychain.put_item(SERVICE, "held", b"held-value");

    let refused = store
        .read(SERVICE, "held")
        .expect_err("a locked keychain refuses the read");

    assert!(refused.is_locked(), "{refused:?}");
    let read = store
        .read(SERVICE, "held")
        .expect("the unlocked keychain reads")
        .expect("the item is there");
    assert_eq!(read.expose_secret(), "held-value");
}

/// The keychain tool's stand-in, run as `security` through the script a store test writes; it
/// does nothing in any other run.
#[test]
#[ignore = "run only as the keychain tool's stand-in, through the script a store test writes"]
fn the_keychain_tool_stand_in() {
    run_keychain_tool_stand_in();
}
