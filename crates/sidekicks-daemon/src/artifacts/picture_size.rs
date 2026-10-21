//! A picture's natural size, read from its header when its bytes are stored, never from its pixels:
//! the width and height the header declares, swapped when its EXIF orientation turns it a quarter,
//! so the size is the one it is drawn at.
//!
//! Every format is read from the file's first [`PICTURE_METADATA_MAX_BYTES`] bytes, held in
//! memory, so no header or metadata past them is read. On top of that, each reader's own limit:
//!
//! - PNG (animated too) is read through `png`, its text and color-profile chunks skipped.
//! - GIF is read through `gif`, its XMP and color profile held to the bound by its memory limit.
//! - WebP is read through `image-webp`, its EXIF chunk held to the bound by its memory limit, so a
//!   chunk that declares more is never allocated.
//! - JPEG is read through `zune-jpeg`, which stops at the start of the scan. Its default caps
//!   refuse a picture wider or taller than 16,384 pixels, so they are raised: a header read decodes
//!   no pixel.
//!
//! `image`'s wrappers of the first three pass none of these limits and its own JPEG decoder reads
//! the whole file before its header, so each reader is called directly, and `image` reads only the
//! orientation an EXIF chunk holds. Bytes whose header cannot be read within the bound carry no
//! size: the type was read from their leading bytes, and nothing is refused for its type.

use std::fs::File;
use std::io::{self, Cursor, Read as _};
use std::num::NonZeroU64;
use std::path::Path;

use file_format::FileFormat;
use gif::MemoryLimit;
use image::metadata::Orientation;
use image_webp::WebPDecoder;
use sidekicks_contracts::artifacts::operations::ArtifactPictureSize;
use sidekicks_contracts::wire::integer::SafeInt;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::options::DecoderOptions;

/// The bytes of a file a size read may touch: every format's header and metadata are read from
/// this many leading bytes, and GIF's and WebP's memory limits are set to it; a header that lies
/// past it stores no size.
const PICTURE_METADATA_MAX_BYTES: usize = 4 * 1024 * 1024;

/// A picture format whose header the size read takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PictureFormat {
    /// PNG, animated or not.
    Png,
    /// GIF.
    Gif,
    /// WebP.
    Webp,
    /// JPEG.
    Jpeg,
}

impl PictureFormat {
    /// The picture format bytes read as `format` are, or `None` for any format the size read does
    /// not take.
    pub(crate) fn from_file_format(format: FileFormat) -> Option<Self> {
        // `file_format` names hundreds of formats; these five are the pictures the read takes.
        if matches!(
            format,
            FileFormat::PortableNetworkGraphics | FileFormat::AnimatedPortableNetworkGraphics
        ) {
            Some(Self::Png)
        } else if matches!(format, FileFormat::GraphicsInterchangeFormat) {
            Some(Self::Gif)
        } else if matches!(format, FileFormat::Webp) {
            Some(Self::Webp)
        } else if matches!(format, FileFormat::JointPhotographicExpertsGroup) {
            Some(Self::Jpeg)
        } else {
            None
        }
    }
}

/// The size of the `format` picture stored at `path`, or `None` when its header cannot be read
/// within [`PICTURE_METADATA_MAX_BYTES`]. Blocks while it reads the file's leading bytes; fails
/// only when the file cannot be opened or read.
pub(crate) fn read_picture_size(
    path: &Path,
    format: PictureFormat,
) -> io::Result<Option<ArtifactPictureSize>> {
    let mut prefix = Vec::new();
    File::open(path)?
        .take(u64::try_from(PICTURE_METADATA_MAX_BYTES).expect("a few MiB fits a u64"))
        .read_to_end(&mut prefix)?;
    let prefix = Cursor::new(prefix);
    Ok(match format {
        PictureFormat::Png => read_png_size(prefix),
        PictureFormat::Gif => read_gif_size(prefix),
        PictureFormat::Webp => read_webp_size(prefix),
        PictureFormat::Jpeg => read_jpeg_size(prefix),
    })
}

// A PNG's size from its header, oriented by its EXIF chunk when it has one. The text and
// color-profile chunks are skipped unread, and the default limits charge the one decoded row
// `read_info` counts against 64 MiB, so no small budget caps the width.
fn read_png_size(prefix: Cursor<Vec<u8>>) -> Option<ArtifactPictureSize> {
    let mut options = png::DecodeOptions::default();
    options.set_ignore_text_chunk(true);
    options.set_ignore_iccp_chunk(true);
    let reader = png::Decoder::new_with_options(prefix, options)
        .read_info()
        .ok()?;
    let info = reader.info();
    let orientation = info
        .exif_metadata
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    oriented_size(u64::from(info.width), u64::from(info.height), orientation)
}

// A GIF's size from its logical screen, read once its header ends at the first frame.
fn read_gif_size(prefix: Cursor<Vec<u8>>) -> Option<ArtifactPictureSize> {
    let mut options = gif::DecodeOptions::new();
    options.set_memory_limit(MemoryLimit::Bytes(
        NonZeroU64::new(u64::try_from(PICTURE_METADATA_MAX_BYTES).expect("a few MiB fits a u64"))
            .expect("the bound is not zero"),
    ));
    let decoder = options.read_info(prefix).ok()?;
    oriented_size(
        u64::from(decoder.width()),
        u64::from(decoder.height()),
        Orientation::NoTransforms,
    )
}

// A WebP's size from its header, oriented by its EXIF chunk when it has one.
fn read_webp_size(prefix: Cursor<Vec<u8>>) -> Option<ArtifactPictureSize> {
    let mut decoder = WebPDecoder::new(prefix).ok()?;
    decoder.set_memory_limit(PICTURE_METADATA_MAX_BYTES);
    let (width, height) = decoder.dimensions();
    // In memory, the chunk's read fails only when it lies past the bound, and the turn it holds is
    // not known, so neither is the size.
    let orientation = decoder
        .exif_metadata()
        .ok()?
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    oriented_size(u64::from(width), u64::from(height), orientation)
}

// A JPEG's size from its frame header, oriented by its EXIF chunk when it has one.
fn read_jpeg_size(prefix: Cursor<Vec<u8>>) -> Option<ArtifactPictureSize> {
    let options = DecoderOptions::default()
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut decoder = JpegDecoder::new_with_options(prefix, options);
    decoder.decode_headers().ok()?;
    let (width, height) = decoder.dimensions()?;
    let orientation = decoder
        .exif()
        .and_then(|chunk| Orientation::from_exif_chunk(chunk))
        .unwrap_or(Orientation::NoTransforms);
    oriented_size(
        u64::try_from(width).ok()?,
        u64::try_from(height).ok()?,
        orientation,
    )
}

// The size a picture of `width` by `height` is drawn at under `orientation`; none for a header
// that declares no pixel.
fn oriented_size(width: u64, height: u64, orientation: Orientation) -> Option<ArtifactPictureSize> {
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        Orientation::NoTransforms
        | Orientation::Rotate180
        | Orientation::FlipHorizontal
        | Orientation::FlipVertical => (width, height),
    };
    Some(ArtifactPictureSize {
        width: SafeInt::new(width)?,
        height: SafeInt::new(height)?,
    })
}

#[cfg(test)]
mod tests {
    use file_format::FileFormat;
    use gif::{AnyExtension, Encoder as GifEncoder, Frame};
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder as _};
    use image_webp::{ColorType, WebPEncoder};
    use rstest::rstest;

    use super::{PICTURE_METADATA_MAX_BYTES, PictureFormat, read_picture_size};
    use crate::artifacts::detection::detect_media_type;

    /// More metadata than a size read touches, so a header after it lies past the bound.
    const PAST_THE_BOUND: usize = PICTURE_METADATA_MAX_BYTES + 1;

    /// A big-endian TIFF directory holding only `orientation`, padded with zeros to `length`.
    fn exif(orientation: u8, length: usize) -> Vec<u8> {
        let mut exif = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0]);
        exif.resize(length.max(exif.len()), 0);
        exif
    }

    /// Black pixels of `width` by `height`, three bytes each.
    fn pixels(width: u32, height: u32) -> Vec<u8> {
        vec![0; usize::try_from(width * height * 3).expect("a test picture fits")]
    }

    /// A JPEG of `width` by `height`, with an EXIF orientation where one is given.
    fn jpeg(width: u32, height: u32, orientation: Option<u8>) -> Vec<u8> {
        let mut encoded = Vec::new();
        JpegEncoder::new(&mut encoded)
            .encode(
                &pixels(width, height),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .expect("the test encodes a JPEG");
        let Some(orientation) = orientation else {
            return encoded;
        };
        // An APP1 segment holding the EXIF directory.
        let mut body = b"Exif\0\0".to_vec();
        body.extend_from_slice(&exif(orientation, 0));
        let length = u16::try_from(body.len() + 2).expect("the segment is short");
        let mut segment = vec![0xFF, 0xE1];
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(&body);
        encoded.splice(2..2, segment);
        encoded
    }

    /// `jpeg` with APP2 color-profile segments of at least `length` bytes before its frame header.
    fn jpeg_with_profile(jpeg: Vec<u8>, length: usize) -> Vec<u8> {
        const PROFILE_DATA: usize = 65_519;
        let count = length.div_ceil(PROFILE_DATA + 18);
        let mut segments = Vec::new();
        for sequence in 1..=count {
            segments.extend_from_slice(&[0xFF, 0xE2, 0xFF, 0xFF]);
            segments.extend_from_slice(b"ICC_PROFILE\0");
            segments.push(u8::try_from(sequence).expect("a test profile has few segments"));
            segments.push(u8::try_from(count).expect("a test profile has few segments"));
            segments.resize(segments.len() + PROFILE_DATA, 0);
        }
        assert!(segments.len() >= length);
        let mut encoded = jpeg;
        encoded.splice(2..2, segments);
        encoded
    }

    /// `jpeg` cut right after its start-of-scan header, so no scan byte follows.
    fn cut_after_scan_header(jpeg: &[u8]) -> Vec<u8> {
        let marker = jpeg
            .windows(2)
            .position(|pair| pair == [0xFF, 0xDA])
            .expect("a JPEG has a start of scan");
        let length = usize::from(u16::from_be_bytes([jpeg[marker + 2], jpeg[marker + 3]]));
        jpeg[..marker + 2 + length].to_vec()
    }

    /// A PNG chunk of `kind` holding `data`, its length before and its CRC after.
    fn png_chunk(kind: [u8; 4], data: &[u8]) -> Vec<u8> {
        let mut crc = flate2::Crc::new();
        crc.update(&kind);
        crc.update(data);
        let mut chunk = u32::try_from(data.len())
            .expect("a test chunk fits")
            .to_be_bytes()
            .to_vec();
        chunk.extend_from_slice(&kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&crc.sum().to_be_bytes());
        chunk
    }

    /// A PNG of `width` by `height` with `chunks` (each a kind and its data) after its header.
    fn png(width: u32, height: u32, chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut encoded = Vec::new();
        PngEncoder::new(&mut encoded)
            .write_image(
                &pixels(width, height),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .expect("the test encodes a PNG");
        // The signature and the header chunk come first.
        let mut at = 33;
        for (kind, data) in chunks {
            let chunk = png_chunk(**kind, data);
            let length = chunk.len();
            encoded.splice(at..at, chunk);
            at += length;
        }
        encoded
    }

    /// The header of an RGB PNG of `width` by `height`, then an empty image data chunk and its
    /// end: all a size read takes, with no pixel encoded.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut header = width.to_be_bytes().to_vec();
        header.extend_from_slice(&height.to_be_bytes());
        // Eight bits a sample, RGB, the standard compression and filtering, no interlace.
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut encoded = b"\x89PNG\r\n\x1a\n".to_vec();
        encoded.extend_from_slice(&png_chunk(*b"IHDR", &header));
        encoded.extend_from_slice(&png_chunk(*b"IDAT", &[]));
        encoded.extend_from_slice(&png_chunk(*b"IEND", &[]));
        encoded
    }

    /// An animated PNG of `width` by `height`: one frame, played once.
    fn animated_png(width: u32, height: u32) -> Vec<u8> {
        let encoded = png(width, height, &[(b"acTL", b"\0\0\0\x01\0\0\0\0".to_vec())]);
        assert_eq!(
            detect_media_type(&encoded),
            Some(FileFormat::AnimatedPortableNetworkGraphics)
        );
        encoded
    }

    /// A GIF of `width` by `height` whose first frame follows an application extension of
    /// `length` bytes that no reader knows.
    fn gif(width: u16, height: u16, length: usize) -> Vec<u8> {
        let mut encoded = Vec::new();
        let mut encoder = GifEncoder::new(&mut encoded, width, height, &[0, 0, 0, 255, 255, 255])
            .expect("the test writes a GIF header");
        encoder
            .write_raw_extension(
                AnyExtension(0xFF),
                &[b"UNKNOWNAPP1".as_slice(), vec![0; length].as_slice()],
            )
            .expect("the test writes an extension");
        encoder
            .write_frame(&Frame::from_indexed_pixels(
                width,
                height,
                vec![0; usize::from(width) * usize::from(height)],
                None,
            ))
            .expect("the test writes a frame");
        encoder.into_inner().expect("the test ends the GIF");
        encoded
    }

    /// A lossless WebP of `width` by `height`, with an EXIF chunk after its image data and a
    /// color profile before it where one is given.
    fn webp(width: u32, height: u32, exif: Option<Vec<u8>>, profile: Option<Vec<u8>>) -> Vec<u8> {
        let mut encoded = Vec::new();
        let mut encoder = WebPEncoder::new(&mut encoded);
        if let Some(exif) = exif {
            encoder.set_exif_metadata(exif);
        }
        if let Some(profile) = profile {
            encoder.set_icc_profile(profile);
        }
        encoder
            .encode(&pixels(width, height), width, height, ColorType::Rgb8)
            .expect("the test encodes a WebP");
        encoded
    }

    /// The size the bytes store, read as the pipeline reads it.
    fn stored_size(bytes: &[u8]) -> Option<(u64, u64)> {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let path = folder.path().join("picture");
        std::fs::write(&path, bytes).expect("the test writes the picture");
        let format = PictureFormat::from_file_format(detect_media_type(bytes)?)?;
        read_picture_size(&path, format)
            .expect("the test's file opens")
            .map(|size| (size.width.get(), size.height.get()))
    }

    /// A picture stores the size it is drawn at: an orientation that turns it a quarter swaps its
    /// sides and one that does not keeps them, a JPEG past the decoder's default caps and one cut
    /// at its scan read from the header alone, a PNG wider than one decoded row of the bound reads
    /// from its header, an animated PNG reads as a PNG, a PNG's and a WebP's EXIF turn them, a GIF
    /// reads past a short extension, and text stores no size. In every format, a header that
    /// lies past the bound's worth of metadata stores no size: read in full, it would store one.
    #[rstest]
    #[case::a_quarter_turn_swaps(jpeg(8, 4, Some(6)), Some((4, 8)))]
    #[case::a_half_turn_keeps(jpeg(8, 4, Some(3)), Some((8, 4)))]
    #[case::wider_than_the_default_cap(jpeg(20_000, 1, None), Some((20_000, 1)))]
    #[case::cut_at_its_scan(cut_after_scan_header(&jpeg(8, 4, Some(6))), Some((4, 8)))]
    #[case::a_jpeg_whose_frame_is_past_the_bound(
        jpeg_with_profile(jpeg(8, 4, None), PAST_THE_BOUND),
        None
    )]
    #[case::a_png(png(8, 4, &[]), Some((8, 4)))]
    #[case::a_png_wider_than_a_row_of_the_bound(png_header(1_400_000, 1), Some((1_400_000, 1)))]
    #[case::an_animated_png(animated_png(8, 4), Some((8, 4)))]
    #[case::a_png_turned_a_quarter(png(8, 4, &[(b"eXIf", exif(6, 0))]), Some((4, 8)))]
    #[case::a_png_whose_exif_is_past_the_bound(
        png(8, 4, &[(b"eXIf", exif(6, PAST_THE_BOUND))]),
        None
    )]
    #[case::a_gif(gif(8, 4, 16), Some((8, 4)))]
    #[case::a_gif_whose_frame_is_past_the_bound(gif(8, 4, PAST_THE_BOUND), None)]
    #[case::a_webp(webp(8, 4, None, None), Some((8, 4)))]
    #[case::a_webp_turned_a_quarter(webp(8, 4, Some(exif(6, 0)), None), Some((4, 8)))]
    #[case::a_webp_whose_image_is_past_the_bound(
        webp(8, 4, None, Some(vec![0; PAST_THE_BOUND])),
        None
    )]
    #[case::text(b"plain words".to_vec(), None)]
    fn a_picture_stores_the_size_it_is_drawn_at(
        #[case] bytes: Vec<u8>,
        #[case] expected: Option<(u64, u64)>,
    ) {
        assert_eq!(stored_size(&bytes), expected);
    }
}
