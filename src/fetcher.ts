import axios from 'axios';
import { config } from './config';
import { fetchFromMusicBrainz } from './providers/musicbrainz';
import { fetchFromSpotify } from './providers/spotify';
import { fetchFromDiscogs } from './providers/discogs';
import type { TrackMetadata, ParsedFilename, Logger } from './types';

/**
 * Route to the configured provider and return the best metadata match,
 * or null if nothing was found. `log` receives debug lines about the lookup.
 */
export async function fetchMetadata(
  parsed: ParsedFilename,
  log?: Logger
): Promise<TrackMetadata | null> {
  if (config.provider === 'spotify') {
    return fetchFromSpotify(parsed, log);
  }
  if (config.provider === 'discogs') {
    return fetchFromDiscogs(parsed, log);
  }
  return fetchFromMusicBrainz(parsed, log);
}

/**
 * Download a URL and return its body as a Buffer.
 * Returns null on network failure so album art is treated as optional.
 */
export async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      headers: {
        'User-Agent': config.musicBrainz.userAgent,
      },
    });
    return Buffer.from(resp.data);
  } catch (err) {
    return null;
  }
}
