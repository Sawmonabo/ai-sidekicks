//! A picture's natural size, read from its header when its bytes are stored, never from its pixels:
//! the width and height the header declares, swapped when its EXIF orientation turns it a quarter,
//! so the size is the one it is drawn at.
//!
//! - PNG (animated too) and GIF are read through `image`'s decoders, each of which stops at its
//!   header and metadata; PNG's metadata chunks are held to [`PICTURE_METADATA_MAX_BYTES`].
//! - WebP is read through `image-webp`'s own decoder, whose EXIF read is held to the same bound;
//!   `image`'s wrapper of it sets no bound.
//! - JPEG is read through `zune-jpeg`, which stops at the start of the scan. `image`'s own JPEG
//!   decoder reads the whole file into memory before its header, and no bound caps one file's
//!   size. Its default caps refuse a picture wider or taller than 16,384 pixels, so they are
//!   raised: a header read decodes no pixel.
//! - Bytes whose header cannot be read, or whose metadata is past the bound, carry no size: the
//!   type was read from their leading bytes, and nothing is refused for its type.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use file_format::FileFormat;
use image::metadata::Orientation;
use image::{ImageDecoder as _, ImageFormat, ImageReader, Limits};
use image_webp::{DecodingError as WebpDecodingError, WebPDecoder};
use sidekicks_contracts::artifacts::operations::ArtifactPictureSize;
use sidekicks_contracts::wire::integer::SafeInt;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::options::DecoderOptions;

/// The most of a picture's metadata (its EXIF, color profile and text chunks) one header read holds
/// in memory; a PNG or WebP whose metadata is larger stores no size.
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

/// The size of the `format` picture stored at `path`, or `None` when its header cannot be read or
/// its metadata is past [`PICTURE_METADATA_MAX_BYTES`]. Blocks while it reads the header; fails
/// only when the file cannot be opened.
pub(crate) fn read_picture_size(
    path: &Path,
    format: PictureFormat,
) -> io::Result<Option<ArtifactPictureSize>> {
    let reader = BufReader::new(File::open(path)?);
    Ok(match format {
        PictureFormat::Png => read_image_size(reader, ImageFormat::Png),
        PictureFormat::Gif => read_image_size(reader, ImageFormat::Gif),
        PictureFormat::Webp => read_webp_size(reader),
        PictureFormat::Jpeg => read_jpeg_size(reader),
    })
}

// A PNG's or a GIF's size through `image`, its allocations held to the metadata bound and its
// dimensions left open.
fn read_image_size(reader: BufReader<File>, format: ImageFormat) -> Option<ArtifactPictureSize> {
    let mut limits = Limits::default();
    limits.max_alloc =
        Some(u64::try_from(PICTURE_METADATA_MAX_BYTES).expect("a few MiB fits a u64"));
    let mut reader = ImageReader::with_format(reader, format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    // A picture whose metadata cannot be read is drawn as its header lays it out.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    oriented_size(u64::from(width), u64::from(height), orientation)
}

// A WebP's size from its header, oriented by its EXIF chunk when it has one within the bound.
fn read_webp_size(reader: BufReader<File>) -> Option<ArtifactPictureSize> {
    let mut decoder = WebPDecoder::new(reader).ok()?;
    decoder.set_memory_limit(PICTURE_METADATA_MAX_BYTES);
    let (width, height) = decoder.dimensions();
    let orientation = match decoder.exif_metadata() {
        Ok(chunk) => chunk
            .as_deref()
            .and_then(Orientation::from_exif_chunk)
            .unwrap_or(Orientation::NoTransforms),
        // The turn an EXIF chunk past the bound holds is not known, so neither is the size.
        Err(WebpDecodingError::MemoryLimitExceeded) => return None,
        // A picture whose metadata cannot be read is drawn as its header lays it out.
        Err(_) => Orientation::NoTransforms,
    };
    oriented_size(u64::from(width), u64::from(height), orientation)
}

// A JPEG's size from its frame header, oriented by its EXIF chunk when it has one.
fn read_jpeg_size(reader: BufReader<File>) -> Option<ArtifactPictureSize> {
    let options = DecoderOptions::default()
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut decoder = JpegDecoder::new_with_options(reader, options);
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
    use image::codecs::gif::GifEncoder;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder as _};
    use image_webp::{ColorType, WebPEncoder};
    use rstest::rstest;

    use super::{PICTURE_METADATA_MAX_BYTES, PictureFormat, read_picture_size};
    use crate::artifacts::detection::detect_media_type;

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

    /// `jpeg` cut right after its start-of-scan header, so no scan byte follows.
    fn cut_after_scan_header(jpeg: &[u8]) -> Vec<u8> {
        let marker = jpeg
            .windows(2)
            .position(|pair| pair == [0xFF, 0xDA])
            .expect("a JPEG has a start of scan");
        let length = usize::from(u16::from_be_bytes([jpeg[marker + 2], jpeg[marker + 3]]));
        jpeg[..marker + 2 + length].to_vec()
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
            let mut crc = flate2::Crc::new();
            crc.update(*kind);
            crc.update(data);
            let mut chunk = u32::try_from(data.len())
                .expect("a test chunk fits")
                .to_be_bytes()
                .to_vec();
            chunk.extend_from_slice(*kind);
            chunk.extend_from_slice(data);
            chunk.extend_from_slice(&crc.sum().to_be_bytes());
            let length = chunk.len();
            encoded.splice(at..at, chunk);
            at += length;
        }
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

    /// A GIF of `width` by `height`.
    fn gif(width: u32, height: u32) -> Vec<u8> {
        let mut encoded = Vec::new();
        GifEncoder::new(&mut encoded)
            .write_image(
                &pixels(width, height),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .expect("the test encodes a GIF");
        encoded
    }

    /// A lossless WebP of `width` by `height`, with an EXIF chunk where one is given.
    fn webp(width: u32, height: u32, exif: Option<Vec<u8>>) -> Vec<u8> {
        let mut encoded = Vec::new();
        let mut encoder = WebPEncoder::new(&mut encoded);
        if let Some(exif) = exif {
            encoder.set_exif_metadata(exif);
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
    /// at its scan read from the header alone, an animated PNG reads as a PNG, a PNG's and a WebP's
    /// EXIF turn them, a GIF reads its header, and text stores no size. A PNG or WebP whose EXIF
    /// holds a quarter turn past the metadata bound stores no size: read in full, it would store
    /// the turned size.
    #[rstest]
    #[case::a_quarter_turn_swaps(jpeg(8, 4, Some(6)), Some((4, 8)))]
    #[case::a_half_turn_keeps(jpeg(8, 4, Some(3)), Some((8, 4)))]
    #[case::wider_than_the_default_cap(jpeg(20_000, 1, None), Some((20_000, 1)))]
    #[case::cut_at_its_scan(cut_after_scan_header(&jpeg(8, 4, Some(6))), Some((4, 8)))]
    #[case::a_png(png(8, 4, &[]), Some((8, 4)))]
    #[case::an_animated_png(animated_png(8, 4), Some((8, 4)))]
    #[case::a_png_turned_a_quarter(png(8, 4, &[(b"eXIf", exif(6, 0))]), Some((4, 8)))]
    #[case::a_gif(gif(8, 4), Some((8, 4)))]
    #[case::a_webp(webp(8, 4, None), Some((8, 4)))]
    #[case::a_webp_turned_a_quarter(webp(8, 4, Some(exif(6, 0))), Some((4, 8)))]
    #[case::a_png_whose_exif_is_past_the_bound(
        png(8, 4, &[(b"eXIf", exif(6, PICTURE_METADATA_MAX_BYTES + 1))]),
        None
    )]
    #[case::a_webp_whose_exif_is_past_the_bound(
        webp(8, 4, Some(exif(6, PICTURE_METADATA_MAX_BYTES + 1))),
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
