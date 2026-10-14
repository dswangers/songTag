import * as path from 'path';
import type { ParsedFilename } from './types';

// YouTube video ID pattern: 11-char alphanumeric in brackets/parens
const YOUTUBE_ID_RE = /[\[(][a-zA-Z0-9_-]{11}[\])]/g;

// Common YouTube/downloader noise words (case-insensitive, whole phrases)
const NOISE_PHRASES_RE = /\b(official\s+(music\s+)?video|official\s+audio|lyric(s)?\s+video|lyrics?|audio|hd|hq|4k|remaster(ed)?|full\s+album|extended|remix|feat\.?|ft\.?|live\s+(at|from|version)?|session|cover|version|original|explicit)\b/gi;

// Separators commonly used between artist and title in filenames
const ARTIST_TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' _ '];

const TRAILING_SEP_RE = /\s+[-–—]\s*$|^\s*[-–—]\s+/g;
const MULTI_SPACE_RE  = /\s{2,}/g;

const ALBUM_FIELD_RE = /\s+\balbum\s*:\s*(.+)$/i;
const TRAILING_ALBUM_HINT_RE = /\s+\[([^\]]+)\]$/;

function extractAlbumHint(raw: string): { raw: string; rawAlbum?: string } {
  const albumField = raw.match(ALBUM_FIELD_RE);
  if (albumField?.index !== undefined) {
    return {
      raw: raw.slice(0, albumField.index).trim(),
      rawAlbum: albumField[1].trim(),
    };
  }

  const trailingHint = raw.match(TRAILING_ALBUM_HINT_RE);
  if (trailingHint?.index !== undefined) {
    const rawAlbum = trailingHint[1].trim();
    if (rawAlbum) {
      return {
        raw: raw.slice(0, trailingHint.index).trim(),
        rawAlbum,
      };
    }
  }

  return { raw };
}

/**
 * Strip the .mp3 extension and YouTube/download noise from a filename,
 * returning a clean search query and optional artist split.
 */
export function parseFilename(filename: string): ParsedFilename {
  // Remove extension
  let raw = path.basename(filename, path.extname(filename));

  // Remove YouTube IDs
  raw = raw.replace(YOUTUBE_ID_RE, '');

  // Remove parenthesised/bracketed noise phrases entirely
  raw = raw.replace(/[\[(][^\])]*(official|video|lyrics?|audio|hd|hq|4k|remaster|live|cover|remix|feat|ft)[^\])]*[\])]/gi, '');

  // Remove remaining noise phrases
  raw = raw.replace(NOISE_PHRASES_RE, '');

  // Strip orphaned standalone years (e.g. "2009" left after removing "Remastered")
  raw = raw.replace(/\b(19|20)\d{2}\b/g, '');

  // Pass 1: remove dangling separators at start/end (must run before space collapse)
  raw = raw.replace(TRAILING_SEP_RE, '');
  // Pass 2: collapse remaining multiple spaces
  raw = raw.replace(MULTI_SPACE_RE, ' ').trim();
  const albumHint = extractAlbumHint(raw);
  raw = albumHint.raw;

  // Try to split artist – title
  for (const sep of ARTIST_TITLE_SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx > 0) {
      const left = raw.slice(0, idx).trim();
      const right = raw.slice(idx + sep.length).trim();
      if (left && right) {
        return {
          rawArtist: left,
          rawTitle: right,
          rawAlbum: albumHint.rawAlbum,
          query: albumHint.rawAlbum ? `${left} ${right} ${albumHint.rawAlbum}` : `${left} ${right}`,
        };
      }
    }
  }

  return {
    rawTitle: raw,
    rawAlbum: albumHint.rawAlbum,
    query: albumHint.rawAlbum ? `${raw} ${albumHint.rawAlbum}` : raw,
  };
}
