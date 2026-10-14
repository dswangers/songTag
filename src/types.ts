export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  year?: string;
  trackNumber?: string;
  albumArtUrl?: string;
  /** Match confidence 0–100 (provider score), for debugging/low-confidence flags. */
  confidence?: number;
}

/** Sink for human-readable debug lines emitted during a lookup. */
export type Logger = (message: string) => void;

export interface TagResult {
  filePath: string;
  filename: string;
  success: boolean;
  metadata?: TrackMetadata;
  error?: string;
}

export interface ParsedFilename {
  query: string;
  rawTitle: string;
  rawArtist?: string;
  rawAlbum?: string;
}

export type ApiProvider = 'musicbrainz' | 'spotify' | 'discogs';

/** An album search result (for the Albums tab), from Spotify or Discogs. */
export interface AlbumResult {
  id: string;
  name: string;
  artist: string;
  year?: string;
  imageUrl?: string;
  totalTracks?: number;
}

/** A single-track search result (for the Songs tab), from Spotify or Discogs. */
export interface SongResult {
  title: string;
  artist: string;
  album?: string;
  year?: string;
  trackNumber?: string;
  albumArtUrl?: string;
  durationMs?: number;
}

/** A ranked metadata match surfaced by a provider (used by the Retag match picker). */
export interface ProviderCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  year?: string;
  trackNumber?: string;
  albumArtUrl?: string;
  score: number;
  reason: string;
}
