import SpotifyWebApi from 'spotify-web-api-node';
import { config } from '../config';
import { searchTracksAsUser, searchAlbumsAsUser } from '../spotifyAuth';
import type { TrackMetadata, ParsedFilename, Logger, AlbumResult, SongResult } from '../types';

const noop: Logger = () => {};

let spotifyClient: SpotifyWebApi | null = null;
let tokenExpiresAt = 0;

function getClient(): SpotifyWebApi {
  if (!spotifyClient) {
    spotifyClient = new SpotifyWebApi({
      clientId: config.spotify.clientId,
      clientSecret: config.spotify.clientSecret,
    });
  }
  return spotifyClient;
}

async function ensureToken(): Promise<void> {
  if (Date.now() < tokenExpiresAt) return;

  const client = getClient();
  await withRetry(async () => {
    const data = await client.clientCredentialsGrant();
    client.setAccessToken(data.body.access_token);
    tokenExpiresAt = Date.now() + (data.body.expires_in - 60) * 1_000;
  }, console.log);
}

type SpotifyTrackItem = SpotifyApi.TrackObjectFull;

export interface SpotifyCandidate {
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

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_WORDS = ['demo', 'live', 'remaster', 'remastered', 'alternate', 'instrumental', 'karaoke', 'edit', 'mix', 'acoustic'];

function scoreTrack(
  t: SpotifyTrackItem,
  wantTitle: string,
  wantArtist: string,
  wantAlbum?: string
): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;

  const nt = norm(t.name);
  const wt = norm(wantTitle);
  if (nt === wt) { score += 50; reasons.push('exact title'); }
  else if (nt.includes(wt) || wt.includes(nt)) { score += 18; reasons.push('partial title'); }
  else { score -= 15; reasons.push('title mismatch'); }

  if (wantArtist) {
    const wa = norm(wantArtist);
    const artists = t.artists.map((a) => norm(a.name));
    if (artists.some((a) => a === wa)) { score += 50; reasons.push('exact artist'); }
    else if (artists.some((a) => a.includes(wa) || wa.includes(a))) { score += 12; reasons.push('partial artist'); }
    else { score -= 25; reasons.push('artist mismatch'); }
  }

  if (wantAlbum) {
    const album = norm(t.album.name);
    const wantedAlbum = norm(wantAlbum);
    if (album === wantedAlbum) { score += 40; reasons.push('exact album'); }
    else if (album.includes(wantedAlbum) || wantedAlbum.includes(album)) { score += 16; reasons.push('partial album'); }
    else { score -= 18; reasons.push('album mismatch'); }
  }

  for (const w of VERSION_WORDS) {
    if (nt.includes(w) && !wt.includes(w)) { score -= 6; reasons.push(`-"${w}"`); }
  }

  score += (t.popularity ?? 0) / 25;
  return { score, reason: reasons.join(', ') };
}

function quoteField(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

function spotifyErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    // spotify-web-api-node throws { statusCode, error: { status, message } }
    const inner = o.error;
    if (inner && typeof inner === 'object') {
      const i = inner as Record<string, unknown>;
      if (typeof i.message === 'string') return `Spotify ${o.statusCode ?? ''}: ${i.message}`.trim();
    }
    if (typeof o.message === 'string') return o.message;
    return `Spotify error ${o.statusCode ?? JSON.stringify(o)}`;
  }
  return String(err);
}

function spotifyError(err: unknown): Error {
  return new Error(spotifyErrorMessage(err));
}

function isRateLimit(err: unknown): boolean {
  if (err && typeof err === 'object') {
    return (err as Record<string, unknown>).statusCode === 429;
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, log: Logger): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimit(err) && attempt < 3) {
        const wait = 2_000 * (attempt + 1);
        log(`  rate limited, waiting ${wait / 1000}s…`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw spotifyError(err);
    }
  }
  throw new Error('Spotify rate limit exceeded after retries');
}

const searchCache = new Map<string, SpotifyApi.TrackObjectFull[]>();

async function searchTracks(
  client: SpotifyWebApi,
  q: string,
  log: Logger
): Promise<SpotifyApi.TrackObjectFull[]> {
  const key = q.toLowerCase().trim();
  if (searchCache.has(key)) {
    log(`  Spotify query (cached): ${q}`);
    return searchCache.get(key)!;
  }
  log(`  Spotify query: ${q}`);

  // Prefer the user's OAuth token — it has a higher rate limit than Client Credentials.
  const results = await withRetry(async () => {
    // Use the user's OAuth token if connected — if not, fall back to Client Credentials.
    // Never try both: that would double requests against the same rate-limit bucket.
    const userResults = await searchTracksAsUser(q, 10);
    if (userResults !== null) return userResults;
    const resp = await client.searchTracks(q, { limit: 10 });
    return resp.body.tracks?.items ?? [];
  }, log);

  searchCache.set(key, results);
  return results;
}

export async function searchSpotifyCandidates(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<SpotifyCandidate[]> {
  await ensureToken();

  const client = getClient();

  log(
    `  parsed -> title="${parsed.rawTitle}"` +
    `${parsed.rawArtist ? ` artist="${parsed.rawArtist}"` : ' (no artist)'}` +
    `${parsed.rawAlbum ? ` album="${parsed.rawAlbum}"` : ''}`
  );

  // Build structured query with quoted field values (prevents Lucene syntax errors
  // from parentheses / apostrophes in titles).
  const queryParts = [`track:${quoteField(parsed.rawTitle)}`];
  if (parsed.rawArtist) queryParts.push(`artist:${quoteField(parsed.rawArtist)}`);
  if (parsed.rawAlbum) queryParts.push(`album:${quoteField(parsed.rawAlbum)}`);
  const q = queryParts.join(' ');

  let tracks = await searchTracks(client, q, log);

  // Fall back to free-text search for obscure tracks where field filters return nothing.
  if (tracks.length === 0 && parsed.rawArtist) {
    const fallbackQ = `${parsed.rawTitle} ${parsed.rawArtist}`;
    log(`  no results, trying free-text: ${fallbackQ}`);
    tracks = await searchTracks(client, fallbackQ, log);
  }

  if (tracks.length === 0) {
    log('  no results from Spotify');
    return [];
  }

  const ranked = tracks
    .map((t) => ({ t, ...scoreTrack(t, parsed.rawTitle, parsed.rawArtist ?? '', parsed.rawAlbum) }))
    .sort((a, b) => b.score - a.score);

  log(`  ${tracks.length} candidate(s); top matches:`);
  ranked.slice(0, 5).forEach((c, i) => {
    log(`    ${i + 1}. score=${Math.round(c.score)} "${c.t.name}" - ${c.t.artists.map((a) => a.name).join(', ')} [${c.t.album.name}] (${c.reason})`);
  });

  return ranked.map((c) => ({
    id: c.t.id,
    title: c.t.name,
    artist: c.t.artists.map((a) => a.name).join(', '),
    album: c.t.album.name,
    year: c.t.album.release_date ? c.t.album.release_date.slice(0, 4) : undefined,
    trackNumber: c.t.track_number?.toString(),
    albumArtUrl: c.t.album.images[0]?.url,
    score: Math.round(c.score),
    reason: c.reason,
  }));
}

/**
 * Search Spotify for albums (for the Albums tab). Prefers the user's OAuth token
 * when connected, falling back to Client Credentials otherwise.
 */
export async function searchSpotifyAlbums(q: string, limit = 10): Promise<AlbumResult[]> {
  await ensureToken();
  const client = getClient();

  const items = await withRetry(async () => {
    const userResults = await searchAlbumsAsUser(q, limit);
    if (userResults !== null) return userResults;
    const resp = await client.searchAlbums(q, { limit });
    return resp.body.albums?.items ?? [];
  }, console.log);

  return items
    .filter((a) => a && a.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      artist: (a.artists ?? []).map((ar) => ar.name).filter(Boolean).join(', '),
      year: a.release_date ? a.release_date.slice(0, 4) : undefined,
      // Smallest image that's still sharp in the 140px (2x on HiDPI) preview;
      // the 64px thumbnail looks blurry there.
      imageUrl: [...(a.images ?? [])]
        .sort((x, y) => (x.width ?? 0) - (y.width ?? 0))
        .find((im) => (im.width ?? 0) >= 300)?.url ?? a.images?.[0]?.url,
      totalTracks: (a as SpotifyApi.AlbumObjectSimplified & { total_tracks?: number }).total_tracks,
    }));
}

/** Search Spotify for individual tracks (for the Songs tab). */
export async function searchSpotifyTracks(
  q: string,
  limit = 10,
  offset = 0
): Promise<{ songs: SongResult[]; nextOffset: number; hasMore: boolean }> {
  await ensureToken();
  const client = getClient();

  const items = await withRetry(async () => {
    const userResults = await searchTracksAsUser(q, limit, offset);
    if (userResults !== null) return userResults;
    const resp = await client.searchTracks(q, { limit, offset });
    return resp.body.tracks?.items ?? [];
  }, console.log);

  const songs = items
    .filter((t) => t && t.id)
    .map((t) => ({
      title: t.name,
      artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(', '),
      album: t.album?.name,
      year: t.album?.release_date ? t.album.release_date.slice(0, 4) : undefined,
      trackNumber: t.track_number?.toString(),
      albumArtUrl: t.album?.images?.[0]?.url,
      durationMs: t.duration_ms,
    }));

  // No reliable total here, so infer "more" from a full page.
  return { songs, nextOffset: offset + items.length, hasMore: items.length >= limit };
}

const MIN_CONFIDENCE = 60;

export async function fetchFromSpotify(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<TrackMetadata | null> {
  const ranked = await searchSpotifyCandidates(parsed, log);
  if (ranked.length === 0) return null;

  const track = ranked[0];
  if (track.score < MIN_CONFIDENCE) {
    log(`  top score ${track.score} below threshold ${MIN_CONFIDENCE} — skipping (no reliable match)`);
    return null;
  }
  log(`  chosen: "${track.title}" - ${track.artist} [${track.album}] (score ${track.score})`);

  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    year: track.year,
    trackNumber: track.trackNumber,
    albumArtUrl: track.albumArtUrl,
    confidence: track.score,
  };
}
