use std::path::{Path, PathBuf};

use rstest::rstest;
use sidekicks_platforms::ProcessRecord;

use super::{find_holder_socket, find_link_holder};
use crate::driver::codex::service::record::LastingServiceRecord;

const HOME: &str = "/home/app-server-control/app-server-control.sock";
const OWN: &str = "/sockets/own";

// A record of a running service recorded on `socket`, draining when `is_draining`.
fn recorded(socket: &str, is_draining: bool) -> LastingServiceRecord {
    let process: ProcessRecord =
        serde_json::from_str(r#"{"id":1,"start":1,"boot":"b"}"#).expect("the record reads");
    LastingServiceRecord {
        process,
        home_socket: PathBuf::from(HOME),
        physical_socket: Some(PathBuf::from(socket)),
        is_draining,
        telemetry: None,
    }
}

// Fails when the holder is read from the link alone, which on a system with no link, where
// the home's path is the socket itself, never finds the running service on it, so a daemon's
// restart drains it instead of joining it; or when a draining record holds the link.
#[rstest]
#[case::the_link_names_the_service(Some(OWN), true, &[(HOME, false), (OWN, false)], Some(1))]
#[case::no_link_where_links_are_made(None, true, &[(HOME, false)], None)]
#[case::no_link_where_the_path_is_the_socket(None, false, &[(HOME, false)], Some(0))]
#[case::the_service_on_the_path_drains(None, false, &[(HOME, true)], None)]
#[case::the_service_the_link_names_drains(Some(OWN), true, &[(HOME, false), (OWN, true)], None)]
fn the_link_holder_is_the_running_service_the_link_or_the_path_reaches(
    #[case] link_target: Option<&str>,
    #[case] can_link_a_socket: bool,
    #[case] records: &[(&str, bool)],
    #[case] holder: Option<usize>,
) {
    let records: Vec<LastingServiceRecord> = records
        .iter()
        .map(|(socket, is_draining)| recorded(socket, *is_draining))
        .collect();

    let holder_socket = find_holder_socket(
        link_target.map(PathBuf::from),
        Path::new(HOME),
        can_link_a_socket,
    );

    assert_eq!(find_link_holder(&records, holder_socket.as_deref()), holder);
}
