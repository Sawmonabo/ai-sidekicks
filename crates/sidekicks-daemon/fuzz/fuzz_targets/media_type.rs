//! Reads a payload's media type from arbitrary leading bytes through the daemon's own detection
//! module, as the daemon does for every file it takes in; any panic is a crash. Outside
//! `cargo fuzz` it builds as an empty program, so no other build compiles libFuzzer.

#![cfg_attr(fuzzing, no_main)]

#[cfg(fuzzing)]
#[path = "../../../sidekicks-artifact/src/detection.rs"]
mod detection;

#[cfg(fuzzing)]
libfuzzer_sys::fuzz_target!(|leading_bytes: &[u8]| {
    detection::detect_media_type(leading_bytes);
});

#[cfg(not(fuzzing))]
fn main() {}
