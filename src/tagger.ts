import NodeID3 from "node-id3";
import type { TrackMetadata } from "./types";

/**
 * Derive the MIME type from the first bytes of an image buffer.
 * Defaults to image/jpeg for unknown signatures.
 */
function mimeFromBuffer(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

/** Tags already present in a file (e.g. embedded by yt-dlp at download). */
export interface ExistingTags {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: string;
  description?: string;
  sourceUrl?: string;
  /** Stored match confidence 0–100 (written by SongTag at tag time). */
  score?: number;
}

function readUserText(
  tags: NodeID3.Tags,
  descriptions: string[],
): string | undefined {
  const wanted = descriptions.map((d) => d.toLowerCase());
  const frames = Array.isArray(tags.userDefinedText)
    ? tags.userDefinedText
    : tags.userDefinedText
      ? [tags.userDefinedText]
      : [];

  for (const frame of frames) {
    const description = frame.description?.toLowerCase();
    const value = frame.value?.toString().trim();
    if (description && value && wanted.includes(description)) return value;
  }

  return undefined;
}

/**
 * Read existing ID3 tags from a file. Returns an empty object if the file
 * has no tags or cannot be read.
 */
export function readExistingTags(filePath: string): ExistingTags {
  try {
    const tags = NodeID3.read(filePath);
    return {
      title: tags.title?.trim() || undefined,
      artist: tags.artist?.trim() || undefined,
      album: tags.album?.trim() || undefined,
      trackNumber: tags.trackNumber?.toString().trim() || undefined,
      description: readUserText(tags, ["description", "synopsis"]),
      sourceUrl: readUserText(tags, ["purl", "comment"]),
      score: (() => {
        const v = readUserText(tags, ["songtag-score"]);
        return v !== undefined ? parseInt(v, 10) : undefined;
      })(),
    };
  } catch {
    return {};
  }
}

/**
 * A file counts as "fully tagged" once it has an album track number — the
 * full lookup writes this, but the quick playlist-convert step does not.
 */
export function isFullyTagged(filePath: string): boolean {
  return !!readExistingTags(filePath).trackNumber;
}

/**
 * Write ID3v2 tags (title, artist, album, year, track, album art) into
 * the MP3 at `filePath` in-place.  Returns true on success.
 */
export function writeId3Tags(
  filePath: string,
  metadata: TrackMetadata,
  imageBuffer: Buffer | null,
): boolean {
  // Grab just the first artist before the comma to use as the Album Artist
  const artists = metadata.artist
    ? metadata.artist.split(",").map((a) => a.trim())
    : [];
  const primaryArtist = artists[0] || metadata.artist;

  const tags: NodeID3.Tags = {
    title: metadata.title,
    artist: metadata.artist, // Keeps "Main, Feature" for track-level display
    performerInfo: primaryArtist, // THIS acts as the "Album Artist" to unify the folder
    album: metadata.album,
    ...(metadata.year ? { year: metadata.year } : {}),
    ...(metadata.trackNumber ? { trackNumber: metadata.trackNumber } : {}),
  };

  if (imageBuffer) {
    tags.image = {
      mime: mimeFromBuffer(imageBuffer),
      type: { id: 3, name: "front cover" },
      description: "Cover",
      imageBuffer,
    };
  }

  if (metadata.confidence !== undefined) {
    tags.userDefinedText = [
      { description: "songtag-score", value: String(Math.round(metadata.confidence)) },
    ];
  }

  const result = NodeID3.write(tags, filePath);
  if (result === true) return true;
  throw result instanceof Error ? result : new Error(String(result));
}

/**
 * Merge-update only the given text fields, leaving everything else (notably any
 * existing embedded cover art) untouched. Used when we have authoritative
 * title/artist but no replacement album art.
 */
export function updateId3Tags(
  filePath: string,
  fields: { title?: string; artist?: string; album?: string; year?: string },
): boolean {
  const tags: NodeID3.Tags = {};
  if (fields.title) tags.title = fields.title;
  if (fields.artist) tags.artist = fields.artist;
  if (fields.album) tags.album = fields.album;
  if (fields.year) tags.year = fields.year;

  const result = NodeID3.update(tags, filePath);
  if (result === true) return true;
  throw result instanceof Error ? result : new Error(String(result));
}
