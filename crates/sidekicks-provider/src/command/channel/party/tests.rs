use std::collections::VecDeque;
use std::time::{Duration, Instant};

use hpke::Kem as _;
use sidekicks_platforms::FolderArrivalWait;

use super::{PartyRequests, RequestError};
use crate::command::channel::{
    ChannelKem, DaemonRequest, Direction, REQUESTS_FOLDER, record_context, record_name, seal,
    write_record,
};

// Fails when a request the listing found is lost: a second request of one listing never handed
// out, a request removed before its read ending the party's reads, or one whose read fails dropped
// unsaid or ending the reads after it. Mutations: drop the `pending.extend` and hand out only the
// first arrival; return a `NotFound` read as the failure in `read_request`; answer `Ok(None)` for
// every failed read.
#[test]
fn every_request_of_a_listing_comes_in_order_and_a_gone_one_is_passed_over() {
    let folder = tempfile::tempdir().expect("a folder");
    let requests_folder = folder.path().join(REQUESTS_FOLDER);
    std::fs::create_dir(&requests_folder).expect("the requests folder is made");
    let (daemon, party_keys) = (ChannelKem::gen_keypair(), ChannelKem::gen_keypair());
    let party = 77;
    let write = |sequence, request: &DaemonRequest| {
        let plaintext = serde_json::to_vec(request).expect("a request writes");
        let context = record_context(Direction::ToParty, party, sequence);
        let sealed = seal(&daemon, &party_keys.1, &context, &plaintext).expect("it seals");
        write_record(&requests_folder, &record_name(party, sequence), &sealed)
            .expect("the request is written");
    };
    let mut requests = PartyRequests {
        party,
        private_key: party_keys.0.clone(),
        daemon_key: daemon.1.clone(),
        last_sequence: 0,
        watch: FolderArrivalWait::watch(&requests_folder).expect("the folder is watched"),
        pending: VecDeque::new(),
    };
    let mut next = || {
        requests
            .next_request(Some(Instant::now() + Duration::from_secs(5)))
            .expect("the watch holds")
            .expect("a request comes")
    };
    write(1, &DaemonRequest::Go {});
    write(2, &DaemonRequest::Stop {});
    assert_eq!(next(), DaemonRequest::Go {});
    assert_eq!(next(), DaemonRequest::Stop {});
    write(3, &DaemonRequest::Go {});
    write(4, &DaemonRequest::Stop {});
    assert_eq!(next(), DaemonRequest::Go {});
    std::fs::remove_file(requests_folder.join(record_name(party, 4)))
        .expect("the listed request is removed");
    write(
        5,
        &DaemonRequest::Answer {
            text: "after".to_owned(),
        },
    );
    assert_eq!(
        next(),
        DaemonRequest::Answer {
            text: "after".to_owned()
        }
    );
    // A folder renamed in under a request's name, as a request is, fails its read.
    let unreadable = folder.path().join("unreadable");
    std::fs::create_dir(&unreadable).expect("a folder is made");
    std::fs::rename(&unreadable, requests_folder.join(record_name(party, 6)))
        .expect("it is renamed in");
    write(7, &DaemonRequest::Stop {});
    let deadline = Some(Instant::now() + Duration::from_secs(5));
    let mut unreadable_said = false;
    let stop = loop {
        match requests.next_request(deadline) {
            Ok(request) => break request.expect("a request comes"),
            Err(RequestError::Unreadable(_)) => unreadable_said = true,
            Err(RequestError::Watch(error)) => panic!("the watch fails: {error}"),
        }
    };
    assert!(unreadable_said, "the unreadable request is said");
    assert_eq!(stop, DaemonRequest::Stop {});
}
