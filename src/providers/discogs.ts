import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import type { TrackMetadata, ParsedFilename, Logger, ProviderCandidate } from '../types';

const DISCOGS_BASE = 'https://api.discogs.com';
const noop: Logger = () => {};

/** How closely a match must score (0–100-ish) before we trust it for auto-tagging. */
const MIN_CONFIDENCE = 60;
/** Cap on release look-ups per search — each is a separate API call (rate limited). */
const MAX_RELEASE_FETCHES = 4;

// ─── Discogs search shapes (only the fields we use) ──────────────────────────
interface DiscogsSearchResult {
  id: number;
  type: string;
  title: string; // Discogs formats this as "Artist - Album"
  year?: string;
  cover_image?: string;
  thumb?: string;
  format?: string[];
  genre?: string[];
}

interface DiscogsTrack {
  position: string;
  type_?: string;
  title: string;
  artists?: Array<{ name: string }>;
}

interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  artists?: Array<{ name: string }>;
  images?: Array<{ type: string; uri: string; uri150?: string }>;
  tracklist?: DiscogsTrack[];
}

// ─── Authenticated client + polite throttle ──────────────────────────────────
let client: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (!client) {
    client = axios.create({
      baseURL: DISCOGS_BASE,
      headers: {
        'User-Agent': config.discogs.userAgent,
        Authorization: `Discogs token=${config.discogs.token}`,
        Accept: 'application/vnd.discogs.v2.discogs+json',
      },
      timeout: 15_000,
    });
  }
  return client;
}

// Discogs allows 60 authenticated requests/minute over a rolling window. Serialise
// calls through a single chain and keep a minimum gap so a tagging run never trips
// the limit; back off on 429s and when the remaining-quota header runs low.
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
const MIN_GAP_MS = 1100; // ≈ 54 req/min, safely under the 60 cap

async function spaceOut(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function discogsErrorMessage(err: unknown): string {
  const anyErr = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
  const status = anyErr?.response?.status;
  const msg = anyErr?.response?.data?.message ?? anyErr?.message;
  if (status === 401) return 'Discogs rejected the token (401). Check DISCOGS_TOKEN in your .env.';
  if (status) return `Discogs ${status}: ${msg ?? 'request failed'}`;
  return msg ?? String(err);
}

async function discogsGet<T>(url: string, params: Record<string, unknown>, log: Logger): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await spaceOut();
      try {
        const resp = await getClient().get<T>(url, { params });
        const remaining = Number(resp.headers['x-discogs-ratelimit-remaining']);
        if (!Number.isNaN(remaining) && remaining <= 2) {
          log(`  Discogs quota low (${remaining} left) — pausing briefly…`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
        return resp.data;
      } catch (err) {
        const status = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response?.status;
        if (status === 429 && attempt < 3) {
          const retryAfter = Number((err as any)?.response?.headers?.['retry-after']) || 2 * (attempt + 1);
          log(`  Discogs rate limited — waiting ${retryAfter}s…`);
          await new Promise((r) => setTimeout(r, retryAfter * 1_000));
          continue;
        }
        throw new Error(discogsErrorMessage(err));
      }
    }
    throw new Error('Discogs rate limit exceeded after retries');
  };

  // Keep the chain alive even when a call rejects (run ignores the prior result).
  const result = chain.then(run, run) as Promise<T>;
  chain = result.catch(() => undefined);
  return result;
}

// ─── Scoring helpers ─────────────────────────────────────────────────────────
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_WORDS = ['demo', 'live', 'remaster', 'remastered', 'alternate', 'instrumental', 'karaoke', 'edit', 'mix', 'acoustic'];

/** Discogs disambiguates duplicate artist names with a "(2)" suffix — strip it. */
function cleanArtist(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, '').trim();
}

/** Cheap pre-ranking of a search result (no API call) so we fetch the best releases first. */
function preScore(r: DiscogsSearchResult, parsed: ParsedFilename): number {
  let s = 0;
  const parts = r.title.split(' - ');
  const rArtist = parts.length > 1 ? norm(parts[0]) : '';
  const rAlbum = parts.length > 1 ? norm(parts.slice(1).join(' - ')) : norm(r.title);

  if (parsed.rawArtist) {
    const wa = norm(parsed.rawArtist);
    if (rArtist === wa) s += 40;
    else if (rArtist && (rArtist.includes(wa) || wa.includes(rArtist))) s += 15;
    else s -= 10;
  }
  if (parsed.rawAlbum) {
    const wal = norm(parsed.rawAlbum);
    if (rAlbum === wal) s += 25;
    else if (rAlbum.includes(wal) || wal.includes(rAlbum)) s += 10;
  }
  if (r.cover_image && !/spacer\.gif/.test(r.cover_image)) s += 5;
  const fmt = (r.format ?? []).map((f) => f.toLowerCase());
  if (fmt.some((f) => f.includes('album') || f === 'lp' || f === 'cd')) s += 4;
  if (fmt.some((f) => f.includes('single'))) s -= 1;
  // Nudge toward earlier (likely original) pressings.
  const year = parseInt(r.year ?? '0', 10);
  if (year > 0) s += Math.max(0, 2025 - year) / 200;
  return s;
}

/** Final confidence once we have the real track title from the release tracklist. */
function scoreMatch(
  foundTitle: string,
  foundArtist: string,
  foundAlbum: string,
  wantTitle: string,
  wantArtist: string,
  wantAlbum?: string
): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;

  const nt = norm(foundTitle);
  const wt = norm(wantTitle);
  if (nt === wt) { score += 50; reasons.push('exact title'); }
  else if (nt.includes(wt) || wt.includes(nt)) { score += 18; reasons.push('partial title'); }
  else { score -= 15; reasons.push('title mismatch'); }

  if (wantArtist) {
    const wa = norm(wantArtist);
    const fa = norm(foundArtist);
    if (fa === wa) { score += 50; reasons.push('exact artist'); }
    else if (fa && (fa.includes(wa) || wa.includes(fa))) { score += 12; reasons.push('partial artist'); }
    else { score -= 25; reasons.push('artist mismatch'); }
  }

  if (wantAlbum) {
    const wal = norm(wantAlbum);
    const fal = norm(foundAlbum);
    if (fal === wal) { score += 30; reasons.push('exact album'); }
    else if (fal.includes(wal) || wal.includes(fal)) { score += 12; reasons.push('partial album'); }
  }

  for (const w of VERSION_WORDS) {
    if (nt.includes(w) && !wt.includes(w)) { score -= 8; reasons.push(`-"${w}"`); }
  }

  return { score, reason: reasons.join(', ') };
}

/** Pick the album art URL, preferring the search thumbnail then the release's primary image. */
function pickArt(result: DiscogsSearchResult | undefined, rel: DiscogsRelease): string | undefined {
  if (result?.cover_image && !/spacer\.gif/.test(result.cover_image)) return result.cover_image;
  const primary = rel.images?.find((im) => im.type === 'primary');
  return primary?.uri ?? rel.images?.[0]?.uri;
}

/** Locate the wanted track within a release and compute a human track number. */
function findTrack(rel: DiscogsRelease, wantTitle: string): { track: DiscogsTrack; number: number } | null {
  // Keep only real audio tracks (drop headings / index entries).
  const tracks = (rel.tracklist ?? []).filter((t) => (t.type_ ? t.type_ === 'track' : true) && t.title);
  if (tracks.length === 0) return null;

  const wt = norm(wantTitle);
  let idx = tracks.findIndex((t) => norm(t.title) === wt);
  if (idx < 0) idx = tracks.findIndex((t) => {
    const n = norm(t.title);
    return n.includes(wt) || wt.includes(n);
  });
  if (idx < 0) return null;
  return { track: tracks[idx], number: idx + 1 };
}

// ─── Search ──────────────────────────────────────────────────────────────────
async function searchReleases(parsed: ParsedFilename, log: Logger): Promise<DiscogsSearchResult[]> {
  const base: Record<string, unknown> = { type: 'release', per_page: 10 };

  // 1) Fielded search: track (+ artist, + album hint) — most precise.
  const fielded: Record<string, unknown> = { ...base, track: parsed.rawTitle };
  if (parsed.rawArtist) fielded.artist = parsed.rawArtist;
  if (parsed.rawAlbum) fielded.release_title = parsed.rawAlbum;
  log(`  Discogs query: track="${parsed.rawTitle}"${parsed.rawArtist ? ` artist="${parsed.rawArtist}"` : ''}${parsed.rawAlbum ? ` album="${parsed.rawAlbum}"` : ''}`);
  let results = (await discogsGet<{ results: DiscogsSearchResult[] }>('/database/search', fielded, log)).results ?? [];

  // 2) Free-text "artist title" if the fielded search came up empty.
  if (results.length === 0 && parsed.rawArtist) {
    log('  no fielded results, trying free-text…');
    results = (await discogsGet<{ results: DiscogsSearchResult[] }>(
      '/database/search',
      { ...base, q: `${parsed.rawArtist} ${parsed.rawTitle}` },
      log
    )).results ?? [];
  }

  // 3) Last resort: title alone.
  if (results.length === 0) {
    results = (await discogsGet<{ results: DiscogsSearchResult[] }>(
      '/database/search',
      { ...base, q: parsed.rawTitle },
      log
    )).results ?? [];
  }

  return results.filter((r) => r.type === 'release' && r.id);
}

/**
 * Search Discogs and resolve full per-track metadata for the best matches.
 * Returns ranked candidates (same shape the Spotify provider returns) so the
 * Retag tab's match picker works identically.
 */
export async function searchDiscogsCandidates(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<ProviderCandidate[]> {
  const results = await searchReleases(parsed, log);
  if (results.length === 0) {
    log('  no results from Discogs');
    return [];
  }

  const preRanked = results
    .map((r) => ({ r, pre: preScore(r, parsed) }))
    .sort((a, b) => b.pre - a.pre);

  const candidates: ProviderCandidate[] = [];
  for (let i = 0; i < Math.min(preRanked.length, MAX_RELEASE_FETCHES); i++) {
    const { r } = preRanked[i];
    let rel: DiscogsRelease;
    try {
      rel = await discogsGet<DiscogsRelease>(`/releases/${r.id}`, {}, log);
    } catch (err) {
      log(`  ✗ release ${r.id} lookup failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const found = findTrack(rel, parsed.rawTitle);
    if (!found) continue;

    const artist = found.track.artists?.[0]?.name
      ? cleanArtist(found.track.artists[0].name)
      : rel.artists?.[0]?.name
        ? cleanArtist(rel.artists[0].name)
        : '';
    const album = rel.title;
    const { score, reason } = scoreMatch(
      found.track.title,
      artist,
      album,
      parsed.rawTitle,
      parsed.rawArtist ?? '',
      parsed.rawAlbum
    );

    candidates.push({
      id: String(rel.id),
      title: found.track.title,
      artist,
      album,
      year: rel.year ? String(rel.year) : undefined,
      trackNumber: String(found.number),
      albumArtUrl: pickArt(r, rel),
      score: Math.round(score),
      reason,
    });

    // A confident hit is enough — stop here to spare the rate limit.
    if (score >= 85) break;
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    log(`  ${candidates.length} candidate(s); top matches:`);
    candidates.slice(0, 5).forEach((c, i) =>
      log(`    ${i + 1}. score=${c.score} "${c.title}" - ${c.artist} [${c.album}]${c.trackNumber ? ` #${c.trackNumber}` : ''} (${c.reason})`)
    );
  } else {
    log('  no track-level matches found in Discogs releases');
  }

  return candidates;
}

export async function fetchFromDiscogs(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<TrackMetadata | null> {
  log(`  parsed → title="${parsed.rawTitle}"${parsed.rawArtist ? ` artist="${parsed.rawArtist}"` : ' (no artist)'}${parsed.rawAlbum ? ` album="${parsed.rawAlbum}"` : ''}`);

  const candidates = await searchDiscogsCandidates(parsed, log);
  if (candidates.length === 0) return null;

  const best = candidates[0];
  if (best.score < MIN_CONFIDENCE) {
    log(`  ⚠ top score ${best.score} below threshold ${MIN_CONFIDENCE} — skipping (no reliable match)`);
    return null;
  }
  log(`  ✓ chosen: "${best.title}" - ${best.artist} [${best.album}]${best.trackNumber ? ` #${best.trackNumber}` : ''} (score ${best.score})`);

  return {
    title: best.title,
    artist: best.artist,
    album: best.album,
    year: best.year,
    trackNumber: best.trackNumber,
    albumArtUrl: best.albumArtUrl,
    confidence: best.score,
  };
}
