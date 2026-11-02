use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use secrecy::SecretString;
use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;

use super::RunRedaction;

/// A canary whose forms all differ: a space, quotes, `/` and `+` change its URI, form and JSON
/// forms, and its run of `~` puts `+` in its standard base64 and `-` in its URL-safe base64.
const CANARY: &str = "pass \"word\"/x+~~~~~~~~~";

/// A redaction over `values`.
fn redaction_of(values: &[&str]) -> RunRedaction {
    let secrets: Vec<SecretString> = values
        .iter()
        .map(|value| SecretString::from(*value))
        .collect();
    RunRedaction::new(&secrets)
}

/// Every piece `chunks` writes through one stream of `redaction`, its finish last.
fn streamed(redaction: &RunRedaction, chunks: &[&[u8]]) -> Vec<Vec<u8>> {
    let mut stream = redaction.stream();
    let mut pieces: Vec<Vec<u8>> = chunks.iter().map(|chunk| stream.push(chunk)).collect();
    pieces.push(stream.finish());
    pieces
}

#[test]
fn a_canary_in_each_form_reaches_no_output() {
    let redaction = redaction_of(&[CANARY, "first-line-of-two\nsecond-line-of-two"]);
    let forms = [
        CANARY,
        "pass%20%22word%22%2Fx%2B~~~~~~~~~",
        "pass+%22word%22%2Fx%2B%7E%7E%7E%7E%7E%7E%7E%7E%7E",
        "pass \\\"word\\\"/x+~~~~~~~~~",
        "second-line-of-two",
    ];
    for form in forms {
        assert_eq!(
            redaction.scrub(&format!("before {form} after")),
            format!("before {CREDENTIAL_REDACTION} after"),
            "the form {form:?} was written",
        );
    }
    // A prefix of 0, 1 or 2 bytes puts the canary's aligned core at 0, 2 or 1 bytes into it.
    for (prefix, core_start) in [("", 0), ("u", 2), ("us", 1)] {
        for engine in [&STANDARD, &URL_SAFE] {
            let encoded = engine.encode(format!("{prefix}{CANARY}@host"));
            let tail = &CANARY.as_bytes()[core_start..];
            let core = engine.encode(&tail[..tail.len() - tail.len() % 3]);
            let scrubbed = redaction.scrub(&encoded);
            assert!(
                scrubbed.contains(CREDENTIAL_REDACTION) && !scrubbed.contains(&core),
                "the base64 of {prefix:?} and the canary was written: {scrubbed}",
            );
        }
    }
}

#[test]
fn overlapping_secrets_take_one_mask_with_nothing_of_either_left() {
    let redaction = redaction_of(&["abcd", "cdef"]);

    assert_eq!(
        redaction.scrub("xabcdefy"),
        format!("x{CREDENTIAL_REDACTION}y")
    );
}

#[test]
fn a_secret_split_across_two_pushes_is_masked_at_every_cut() {
    let secret = "Zq9-secret-Value";
    let redaction = redaction_of(&[secret]);
    let text = format!("head {secret} tail");
    for cut in 0..=text.len() {
        let pieces = streamed(
            &redaction,
            &[&text.as_bytes()[..cut], &text.as_bytes()[cut..]],
        );

        assert_eq!(
            pieces.concat(),
            format!("head {CREDENTIAL_REDACTION} tail").into_bytes(),
            "split at byte {cut}",
        );
    }
}

#[test]
fn a_stream_never_splits_a_character_across_two_pieces() {
    // A three-byte secret holds back two bytes, which falls inside each multi-byte character
    // below at some cut.
    let redaction = redaction_of(&["abc"]);
    let text = "aé€😀b😀éabc z".as_bytes();
    for cut in 0..=text.len() {
        let pieces = streamed(&redaction, &[&text[..cut], &text[cut..]]);

        for piece in &pieces {
            assert!(
                std::str::from_utf8(piece).is_ok(),
                "split at byte {cut}: {piece:?}"
            );
        }
        assert_eq!(
            pieces.concat(),
            format!("aé€😀b😀é{CREDENTIAL_REDACTION} z").into_bytes()
        );
    }
}

#[test]
fn a_short_secret_or_line_registers_no_derived_form() {
    // `p/w+d` is under 8 characters, though its URI form `p%2Fw%2Bd` is not; the braces are lines
    // of a longer secret, each under 8 characters.
    let redaction = redaction_of(&["p/w+d", "{\nlong-secret-line-value\n}"]);

    assert_eq!(
        redaction.scrub("q=p%2Fw%2Bd b64=cC93K2Q= raw=p/w+d {ok}"),
        format!("q=p%2Fw%2Bd b64=cC93K2Q= raw={CREDENTIAL_REDACTION} {{ok}}"),
    );
}

#[test]
fn a_secret_added_mid_stream_is_masked_from_the_next_push_and_the_carry_still_is() {
    let first = "alpha-secret-0001";
    let added = "bravo-secret-0002";
    let redaction = redaction_of(&[first]);
    let mut stream = redaction.stream();

    let mut written = stream.push(format!("x {}", &first[..5]).as_bytes());
    redaction.add_secret(&SecretString::from(added));
    written.extend(stream.push(format!("{} then {added} end", &first[5..]).as_bytes()));
    written.extend(stream.finish());

    assert_eq!(
        written,
        format!("x {CREDENTIAL_REDACTION} then {CREDENTIAL_REDACTION} end").into_bytes()
    );
}
