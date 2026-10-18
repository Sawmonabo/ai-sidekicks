//! Reads a payload's media type from arbitrary leading bytes through the daemon's own detection
//! module, as the daemon does for every file it takes in; any panic is a crash.

#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../src/artifacts/detection.rs"]
mod detection;

fuzz_target!(|leading_bytes: &[u8]| {
    detection::detect_media_type(leading_bytes);
});
