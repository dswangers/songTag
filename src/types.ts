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
