//! The stored body's encoding and decoding.

use rstest::rstest;
use sidekicks_contracts::event::declared_variants::ContentEncoding;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use zstd::zstd_safe;

use super::{
    BodyDecodeError, BodyEncoder, StoredBody, StoredBodyPlace, decode_body, decode_body_stretch,
    stored_body_place_sql,
};
use crate::transcript::test_log::TranscriptTestLog;

// A body of `length` UTF-8 bytes whose characters are one, two and three bytes wide, so a frame
// cut by bytes alone would split one.
fn mixed_text(length: usize) -> String {
    let mut text = String::with_capacity(length + 3);
    let characters = ['a', 'é', '€'];
    let mut index = 0;
    while text.len() < length {
        text.push(characters[index % characters.len()]);
        index += 1;
    }
    let end = text.floor_char_boundary(length);
    text.truncate(end);
    while text.len() < length {
        text.push('a');
    }
    text
}

// Each frame of `stored`, as its decoded size.
fn frame_sizes(stored: &[u8]) -> Vec<u64> {
    let mut rest = stored;
    let mut sizes = Vec::new();
    while !rest.is_empty() {
        let frame = zstd_safe::find_frame_compressed_size(rest).expect("a whole frame");
        sizes.push(
            zstd_safe::get_frame_content_size(rest)
                .expect("a frame header")
                .expect("a frame records its size"),
        );
        rest = &rest[frame..];
    }
    sizes
}

// Killed by moving the threshold either way or storing a long body as it is.
#[rstest]
#[case::just_under_a_kibibyte(1023, None)]
#[case::a_kibibyte(1024, Some(ContentEncoding::Zstd))]
fn a_body_is_stored_compressed_from_one_kibibyte(
    #[case] length: usize,
    #[case] encoding: Option<ContentEncoding>,
) {
    let text = mixed_text(length);
    let body = StoredBody::new(text.clone());
    assert_eq!(body.encoding(), encoding);
    let mut encoder = BodyEncoder::new();
    let stored = encoder.encode(&body).expect("the body encodes").to_vec();
    match encoding {
        None => assert_eq!(stored, text.as_bytes()),
        Some(ContentEncoding::Zstd) => {
            assert_eq!(stored[..4], [0x28, 0xb5, 0x2f, 0xfd]);
            assert!(stored.len() < text.len());
        }
    }
    let decoded = decode_body(stored, encoding, Some(length as u64)).expect("the body decodes");
    assert_eq!(decoded, text);
}

// A body of two pages and 300 KiB is stored whole as three frames, one per page of text, each
// ending between characters, and reads back byte for byte. Killed by a frame cut inside a
// character, by frames longer than a page, by a body cut short, and by a decode that stops after
// the first frame.
#[test]
fn a_long_body_reads_back_whole_from_one_frame_per_page() {
    let text = mixed_text(2 * PAGE_MAX_BYTES + 300 * 1024);
    let mut encoder = BodyEncoder::new();
    // The encoder is reused, as the writer thread reuses it, so a stale buffer would show.
    encoder
        .encode(&StoredBody::new(mixed_text(PAGE_MAX_BYTES + 5_000)))
        .expect("the earlier body encodes");
    let stored = encoder
        .encode(&StoredBody::new(text.clone()))
        .expect("the body encodes")
        .to_vec();
    let sizes = frame_sizes(&stored);
    assert_eq!(sizes.len(), 3);
    assert!(sizes.iter().all(|size| *size <= PAGE_MAX_BYTES as u64));
    assert_eq!(sizes.iter().sum::<u64>(), text.len() as u64);
    let decoded = decode_body(stored, Some(ContentEncoding::Zstd), Some(text.len() as u64))
        .expect("the body decodes");
    assert_eq!(decoded, text);
}

// A body that does not decode to the length its payload states, or whose frame fails its
// checksum, is refused, never answered short or damaged. Killed by dropping the length check or
// the checksum flag: a frame stored without its checksum records none in its header.
#[test]
fn a_body_that_does_not_match_its_payload_is_refused() {
    let text = mixed_text(4_096);
    let mut encoder = BodyEncoder::new();
    let stored = encoder
        .encode(&StoredBody::new(text.clone()))
        .expect("the body encodes")
        .to_vec();
    let length = text.len() as u64;
    for stated in [length - 1, length + 1] {
        let refused = decode_body(stored.clone(), Some(ContentEncoding::Zstd), Some(stated));
        assert!(
            matches!(
                refused,
                Err(BodyDecodeError::Length { .. } | BodyDecodeError::Stream(_))
            ),
            "{refused:?}"
        );
    }
    let plain = decode_body(b"short".to_vec(), None, Some(6));
    assert!(
        matches!(
            plain,
            Err(BodyDecodeError::Length {
                stated: 6,
                decoded: 5
            })
        ),
        "{plain:?}"
    );
    assert!(matches!(
        decode_body(stored.clone(), Some(ContentEncoding::Zstd), None),
        Err(BodyDecodeError::NoLength)
    ));
    // The frame header's descriptor, after the four-byte magic number, flags a checksum.
    assert_ne!(stored[4] & 0b100, 0, "the frame records no checksum");
    // The last four bytes are the frame's checksum.
    let mut damaged = stored;
    let last = damaged.len() - 1;
    damaged[last] ^= 0xff;
    let refused = decode_body(damaged, Some(ContentEncoding::Zstd), Some(length));
    assert!(
        matches!(refused, Err(BodyDecodeError::Stream(_))),
        "{refused:?}"
    );
}

// A part read from the middle of a long body decodes only the frames its range falls in: the
// first frame, damaged, is never decoded. Killed by decoding the whole stream or the wrong frames.
#[test]
fn a_part_read_decodes_only_the_frames_it_covers() {
    let text = mixed_text(3 * PAGE_MAX_BYTES - 7);
    let mut encoder = BodyEncoder::new();
    let mut stored = encoder
        .encode(&StoredBody::new(text.clone()))
        .expect("the body encodes")
        .to_vec();
    let sizes = frame_sizes(&stored);
    let first_frame_bytes =
        zstd_safe::find_frame_compressed_size(&stored).expect("the first frame is whole");
    // The first frame's checksum no longer holds, so decoding it fails.
    stored[first_frame_bytes - 1] ^= 0xff;
    let first_end = usize::try_from(sizes[0]).expect("a frame's size fits memory");
    let second_end = first_end + usize::try_from(sizes[1]).expect("a frame's size fits memory");

    let from = first_end + 10;
    let stretch = decode_body_stretch(
        stored.clone(),
        Some(ContentEncoding::Zstd),
        Some(text.len() as u64),
        from,
        from + PAGE_MAX_BYTES,
    )
    .expect("the part's frames decode");
    assert_eq!(stretch.start, first_end);
    assert_eq!(stretch.text, text[first_end..]);

    let within = decode_body_stretch(
        stored.clone(),
        Some(ContentEncoding::Zstd),
        Some(text.len() as u64),
        from,
        from + 1,
    )
    .expect("the part's frame decodes");
    assert_eq!(
        (within.start, within.text.as_str()),
        (first_end, &text[first_end..second_end])
    );

    let at_end = decode_body_stretch(
        stored.clone(),
        Some(ContentEncoding::Zstd),
        Some(text.len() as u64),
        text.len(),
        text.len() + PAGE_MAX_BYTES,
    )
    .expect("a read at the end decodes nothing");
    assert_eq!((at_end.start, at_end.text.as_str()), (text.len(), ""));

    assert!(decode_body(stored, Some(ContentEncoding::Zstd), Some(text.len() as u64)).is_err());
}

// A long body read from its stored column is handed over a frame at a time, each at most a page
// of text, and the frames joined are the body. Killed by handing over the body whole, by a frame
// dropped or repeated, and by a window that loses the bytes past a frame's end.
#[test]
fn a_long_body_streams_from_its_column_a_frame_at_a_time() {
    let log = TranscriptTestLog::new();
    let text = mixed_text(2 * PAGE_MAX_BYTES + 300 * 1024);
    let (sequence, _) = log.reply("m1", None, &text);
    let reader = log.reader();
    let place = reader
        .query_row(
            &format!(
                "SELECT {} FROM session_events AS event WHERE sequence = ?1",
                stored_body_place_sql("event")
            ),
            [sequence],
            |row| StoredBodyPlace::read(row, 0),
        )
        .expect("the row reads")
        .expect("the row holds a body");
    let mut frames: Vec<String> = Vec::new();
    place
        .stream(&reader, |frame| {
            frames.push(frame.to_owned());
            Ok(())
        })
        .expect("the body streams");
    assert_eq!(frames.len(), 3);
    assert!(frames.iter().all(|frame| frame.len() <= PAGE_MAX_BYTES));
    assert_eq!(frames.concat(), text);
}
