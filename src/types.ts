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

export type ApiProvider = 'musicbrainz' | 'spotify';
