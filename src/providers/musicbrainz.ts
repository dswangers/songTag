import axios, { AxiosError } from 'axios';
import { config } from '../config';
import type {
  TrackMetadata,
  ParsedFilename,
  Logger,
  ProviderCandidate,
  AlbumResult,
  SongResult,
} from '../types';
import type { AlbumTrack } from './discogs';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';
const noop: Logger = () => {};

/** How closely a match must score (0–100) before we trust it for auto-tagging. */
const MIN_CONFIDENCE = 60;
/** Title-only lookups (no artist in the filename) are inherently ambiguous. */
const TITLE_ONLY_CAP = 85;
/** MusicBrainz allows ~1 request/second per client; stay just under it. */
const MIN_GAP_MS = 1100;
/** Retries for 503 "server busy" / network errors (backoff 2s, 4s, 8s, 16s, 32s). */
const MAX_RETRIES = 5;

// ─── MusicBrainz response shapes (only the fields we use) ────────────────────
interface MBCredit {
  name: string;
  joinphrase?: string;
  artist: { id: string; name: string };
}

interface MBReleaseGroup {
  id: string;
  title?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  'artist-credit'?: MBCredit[];
  count?: number;
  score?: number;
}

interface MBTrack {
  number?: string;
  position?: number;
  title?: string;
  length?: number;
  'artist-credit'?: MBCredit[];
  recording?: { title?: string; length?: number; 'artist-credit'?: MBCredit[] };
}

interface MBMedium {
  position?: number;
  format?: string;
  'track-count'?: number;
  'track-offset'?: number;
  track?: MBTrack[]; // search results
  tracks?: MBTrack[]; // release lookups
}

interface MBRelease {
  id: string;
  title: string;
  status?: string;
  date?: string;
  'release-group'?: MBReleaseGroup;
  'artist-credit'?: MBCredit[];
  'track-count'?: number;
  media?: MBMedium[];
  'cover-art-archive'?: { front?: boolean };
}

interface MBRecording {
  id: string;
  title: string;
  score: number;
  length?: number;
  disambiguation?: string;
  'first-release-date'?: string;
  'artist-credit'?: MBCredit[];
  releases?: MBRelease[];
}

// ─── HTTP: one shared, throttled, retrying client ────────────────────────────
const mbAxios = axios.create({
  baseURL: MB_BASE,
  headers: { 'User-Agent': config.musicBrainz.userAgent, Accept: 'application/json' },
  timeout: 20_000,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every MusicBrainz request (from any concurrent tag job) waits its turn here,
// so the whole app never exceeds the ~1 req/s rate limit. Bursting past it is
// what produced the wall of 503 errors before.
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
function nextSlot(): Promise<void> {
  const slot = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  queue = slot;
  return slot;
}

async function mbGet<T>(url: string, params: Record<string, string | number>, log: Logger): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await nextSlot();
    try {
      const resp = await mbAxios.get<T>(url, { params: { ...params, fmt: 'json' } });
      return resp.data;
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      const retryable = status === 503 || status === 429 || status === 502 || status === 504 || (ax.isAxiosError && !ax.response);
      if (retryable && attempt < MAX_RETRIES) {
        const wait = 2000 * 2 ** attempt;
        log(`  MusicBrainz busy (${status ?? ax.code ?? 'network'}) — retrying in ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }
      if (status === 404) throw new Error('Not found on MusicBrainz.');
      if (status === 503) throw new Error('MusicBrainz is overloaded right now — try again in a minute.');
      throw new Error(`MusicBrainz request failed${status ? ` (HTTP ${status})` : ''}: ${ax.message ?? String(err)}`);
    }
  }
}

// ─── Text helpers ────────────────────────────────────────────────────────────
/** MusicBrainz uses typographic punctuation (blink‐182, I’m); tag with plain ASCII. */
function tidy(s: string): string {
  return s
    .replace(/[\u2010\u2011\u2012\u2013]/g, '-')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .trim();
}

function norm(s: string): string {
  return tidy(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return norm(s).split(' ').filter(Boolean);
}

/** 0–1 similarity of two names: exact, "The X" vs "X", containment, then token overlap. */
function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const strip = (x: string) => x.replace(/^the /, '');
  if (strip(na) === strip(nb)) return 0.97;
  const ta = new Set(strip(na).split(' '));
  const tb = new Set(strip(nb).split(' '));
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter++; });
  if (inter === 0) return 0;
  const small = Math.min(ta.size, tb.size);
  const big = Math.max(ta.size, tb.size);
  const dice = (2 * inter) / (ta.size + tb.size);
  const contained = inter === small ? 0.6 + 0.3 * (small / big) : 0;
  return Math.max(0.9 * dice, contained);
}

function creditString(c?: MBCredit[]): string {
  if (!c || c.length === 0) return '';
  return tidy(c.map((x) => x.name + (x.joinphrase ?? '')).join(''));
}

/** Best similarity between a wanted artist and a credit (full string or any member). */
function artistSimilarity(c: MBCredit[] | undefined, want: string): number {
  if (!c || c.length === 0) return 0;
  let best = similarity(creditString(c), want);
  for (const x of c) best = Math.max(best, similarity(x.name, want), similarity(x.artist.name, want));
  return best;
}

/** Quote a phrase for a Lucene field query. */
function phrase(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

/** Bag of words for a loose Lucene field query (alphanumeric only, so no operator injection). */
function bag(s: string): string {
  return `(${tokens(s).join(' ')})`;
}

// ─── Version / release preference ────────────────────────────────────────────
/** Words that mark an alternate version — penalised unless the user typed them. */
const ALT_WORDS = [
  'live', 'acoustic', 'demo', 'remix', 'mix', 'instrumental', 'karaoke', 'edit', 'cover',
  'tribute', 'rehearsal', 'session', 'reprise', 'unplugged', 'orchestral', 'lullaby',
  'backing track', 'in the style of', 'originally performed', 'made famous', 'a cappella',
  'acapella', 'sped up', 'slowed', 'nightcore', '8 bit', 'piano version', 'radio edit',
];

function altPenalty(text: string, wanted: string): number {
  const t = ` ${norm(text)} `;
  const w = ` ${norm(wanted)} `;
  let n = 0;
  for (const word of ALT_WORDS) {
    const k = ` ${word} `;
    if (t.includes(k) && !w.includes(k)) n++;
  }
  return n;
}

/** Artists / releases that are karaoke, tribute, or novelty cover acts. */
const COVER_ACT_RE =
  /\b(karaoke|tribute|string quartet|vitamin string|lullab(y|ies)|rockabye|twinkle twinkle|8[- ]?bit|in the style of|made famous|cover band|covers band|backing tracks?|sing[- ]?along|kidz bop|piano tribute|the hit crew|party hits)\b/i;

/** Release titles that are really live bootlegs, e.g. "2000-02-24: Middle East…". */
const BOOTLEG_TITLE_RE = /^\s*\d{4}[-‐–]\d{2}[-‐–]\d{2}/;

/** Score adjustment (≤ 0) for how "canonical" a release is: studio album best. */
function releaseAdj(rel: MBRelease): number {
  let p = 0;
  const rg = rel['release-group'];
  const primary = rg?.['primary-type'];
  const secondary = rg?.['secondary-types'] ?? [];

  if (rel.status === 'Bootleg') p -= 20;
  else if (rel.status === 'Pseudo-Release') p -= 8;
  else if (rel.status === 'Promotion') p -= 4;
  else if (rel.status !== 'Official') p -= 2;

  if (primary === 'EP') p -= 3;
  else if (primary === 'Single') p -= 4;
  else if (primary && primary !== 'Album') p -= 8;
  else if (!primary) p -= 6;

  if (secondary.includes('Compilation')) p -= 10;
  if (secondary.includes('Live')) p -= 15;
  if (secondary.includes('Soundtrack')) p -= 5;
  if (secondary.includes('Demo')) p -= 8;
  if (secondary.some((s) => s === 'Remix' || s === 'DJ-mix' || s === 'Mixtape/Street')) p -= 8;

  if (BOOTLEG_TITLE_RE.test(rel.title)) p -= 15;
  if (COVER_ACT_RE.test(rel.title)) p -= 15;
  return p;
}

/** Prefer CD / digital pressings: their track numbers are plain (no vinyl "A1"). */
function formatRank(rel: MBRelease): number {
  const f = rel.media?.[0]?.format ?? '';
  if (/Digital/i.test(f)) return 0;
  if (/CD/i.test(f)) return 1;
  if (!f) return 2;
  return 3;
}

function trackNumberIn(rel: MBRelease): string | undefined {
  const m = rel.media?.[0];
  if (!m) return undefined;
  if (typeof m['track-offset'] === 'number') return String(m['track-offset'] + 1);
  const num = m.track?.[0]?.number;
  return num && /^\d+$/.test(num) ? num : undefined;
}

function rgCoverUrl(rgId: string, size: 250 | 500 | 1200 = 500): string {
  return `${CAA_BASE}/release-group/${rgId}/front-${size}`;
}

function yearOf(date?: string): string | undefined {
  return date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined;
}

// ─── Release-group first-release dates (one batched search, cached) ──────────
const rgDateCache = new Map<string, string>();

/** Fill rgDateCache for these release groups — one request for up to ~40 ids. */
async function loadReleaseGroupDates(ids: string[], log: Logger): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !rgDateCache.has(id)).slice(0, 40);
  if (missing.length === 0) return;
  try {
    const data = await mbGet<{ 'release-groups'?: MBReleaseGroup[] }>(
      '/release-group',
      { query: missing.map((id) => `rgid:${id}`).join(' OR '), limit: missing.length },
      log
    );
    for (const rg of data['release-groups'] ?? []) rgDateCache.set(rg.id, rg['first-release-date'] ?? '');
  } catch (err) {
    log(`  (could not load album years: ${err instanceof Error ? err.message : err})`);
  }
}

// ─── Recording search + ranking ──────────────────────────────────────────────
/** Restrict a recording query to studio-album appearances (see searchRecordings). */
const STUDIO_FILTER = ' AND status:official AND primarytype:album AND -comment:live';

/**
 * Run a recording query. Search results are capped at 100 and come back in no
 * useful order, so for popular songs (Nirvana has ~490 "Smells Like Teen
 * Spirit" recordings, mostly live bootlegs) the original studio recording can
 * be missing entirely. When there are more than 100 hits we also run the query
 * restricted to official studio albums and merge, so the original is present.
 */
async function searchRecordings(query: string, log: Logger): Promise<MBRecording[]> {
  log(`  MB query: ${query}`);
  const data = await mbGet<{ recordings?: MBRecording[]; count?: number }>('/recording', { query, limit: 100 }, log);
  const recs = data.recordings ?? [];
  if ((data.count ?? 0) <= recs.length) return recs;

  log(`  ${data.count} hits — also searching official studio albums`);
  const studio = await mbGet<{ recordings?: MBRecording[] }>('/recording', { query: query + STUDIO_FILTER, limit: 100 }, log);
  const byId = new Map<string, MBRecording>();
  for (const r of [...(studio.recordings ?? []), ...recs]) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

/** One ranked (recording × release group) match. */
interface Match {
  rec: MBRecording;
  rel: MBRelease;
  rgId: string;
  title: string;
  artist: string;
  album: string;
  trackNumber?: string;
  earliestDate?: string;
  score: number;
  reason: string;
}

/**
 * How many official releases each (artist, song) pair has across the results.
 * MusicBrainz has no popularity data, but the original recording of a song
 * appears on far more releases (reissues, compilations, regional pressings)
 * than covers do — e.g. The Beatles 241 vs. the next cover act's 7.
 */
function popularityTable(recs: MBRecording[]): (rec: MBRecording) => number {
  const counts = new Map<string, number>();
  const keyOf = (r: MBRecording) => `${norm(creditString(r['artist-credit']))}|${norm(r.title)}`;
  for (const r of recs) {
    const n = (r.releases ?? []).filter((x) => x.status === 'Official').length;
    counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + n);
  }
  const max = Math.max(1, ...counts.values());
  return (r) => Math.log(1 + (counts.get(keyOf(r)) ?? 0)) / Math.log(1 + max);
}

/**
 * Interpretations of what the user meant for one recording. With an explicit
 * artist there's one; for free text ("sleep lagwagon") we also try "the words
 * that aren't this recording's artist are the title".
 */
function interpretations(rec: MBRecording, wantTitle: string, wantArtist?: string): Array<{ title: string; artist?: string }> {
  const out: Array<{ title: string; artist?: string }> = [{ title: wantTitle, artist: wantArtist }];
  if (!wantArtist) {
    const q = tokens(wantTitle);
    for (const c of rec['artist-credit'] ?? []) {
      const at = tokens(c.name);
      if (at.length === 0 || at.length >= q.length) continue;
      // Artist words at the start or the end of the query.
      const head = q.slice(0, at.length).join(' ') === at.join(' ');
      const tail = q.slice(q.length - at.length).join(' ') === at.join(' ');
      if (head) out.push({ title: q.slice(at.length).join(' '), artist: c.name });
      if (tail) out.push({ title: q.slice(0, q.length - at.length).join(' '), artist: c.name });
    }
  }
  return out;
}

function rankMatches(recs: MBRecording[], wantTitle: string, wantArtist: string | undefined, wantAlbum?: string): Match[] {
  const popularity = popularityTable(recs);
  const best = new Map<string, Match>();

  for (const rec of recs) {
    if (!rec.releases?.length) continue;
    const credit = creditString(rec['artist-credit']) || 'Unknown Artist';
    const pop = popularity(rec);
    const coverAct = COVER_ACT_RE.test(credit);

    // Best recording-level score over the possible readings of the query.
    let recScore = -Infinity;
    let why = '';
    for (const it of interpretations(rec, wantTitle, wantArtist)) {
      const titleSim = similarity(rec.title, it.title);
      let s = 60 * titleSim + 10 * pop;
      let r = `title ${Math.round(titleSim * 100)}%`;
      if (it.artist) {
        const aSim = artistSimilarity(rec['artist-credit'], it.artist);
        s += 30 * aSim;
        if (aSim < 0.5) s -= 30; // a different artist is a different song
        r += ` · artist ${Math.round(aSim * 100)}%`;
      } else {
        s += 30 * pop; // no artist given: the most-released version is the original
      }
      const alt = altPenalty(`${rec.title} ${rec.disambiguation ?? ''}`, it.title);
      if (alt) { s -= Math.min(40, 20 * alt); r += ' · alt version'; }
      if (coverAct && !(it.artist && artistSimilarity(rec['artist-credit'], it.artist) >= 0.9)) { s -= 25; r += ' · cover act'; }
      if (!it.artist) s = Math.min(s, TITLE_ONLY_CAP);
      if (s > recScore) { recScore = s; why = r; }
    }

    for (const rel of rec.releases) {
      const rgId = rel['release-group']?.id ?? rel.id;
      const key = `${norm(credit)}|${norm(rec.title)}|${rgId}`;
      let adj = releaseAdj(rel);
      if (wantAlbum && similarity(rel['release-group']?.title ?? rel.title, wantAlbum) >= 0.8) adj += 10;
      const score = Math.max(0, Math.min(100, Math.round(recScore + adj)));
      const prev = best.get(key);
      const earliest = [prev?.earliestDate, rel.date].filter(Boolean).sort()[0];

      const better =
        !prev ||
        score > prev.score ||
        (score === prev.score && formatRank(rel) < formatRank(prev.rel)) ||
        (score === prev.score && formatRank(rel) === formatRank(prev.rel) && (rel.date ?? '9') < (prev.rel.date ?? '9'));
      if (better) {
        const rg = rel['release-group'];
        const kind = [rel.status, rg?.['primary-type'], ...(rg?.['secondary-types'] ?? [])].filter(Boolean).join(' ');
        best.set(key, {
          rec,
          rel,
          rgId,
          title: tidy(rec.title),
          artist: credit,
          album: tidy(rg?.title ?? rel.title),
          trackNumber: trackNumberIn(rel),
          earliestDate: earliest,
          score,
          reason: `${why}${kind ? ` · ${kind}` : ''}`,
        });
      } else if (earliest !== prev.earliestDate) {
        prev.earliestDate = earliest;
      }
    }
  }

  return [...best.values()].sort(
    (a, b) => b.score - a.score || (a.earliestDate ?? '9').localeCompare(b.earliestDate ?? '9')
  );
}

/** Fielded searches, from strict to loose, until something comes back. */
async function findRecordings(title: string, artist: string | undefined, log: Logger): Promise<MBRecording[]> {
  if (!title.trim()) return [];
  const attempts: string[] = [];
  if (artist) {
    attempts.push(`recording:${phrase(title)} AND artist:${phrase(artist)}`);
    attempts.push(`recording:${bag(title)} AND artist:${bag(artist)}`);
    attempts.push(`recording:${phrase(artist)} AND artist:${phrase(title)}`); // "Title - Artist" filenames
  }
  attempts.push(`recording:${phrase(title)}`);
  attempts.push(`recording:${bag(title)}`);

  for (const q of attempts) {
    const recs = await searchRecordings(q, log);
    if (recs.length > 0) return recs;
  }
  return [];
}

function matchToCandidate(m: Match): ProviderCandidate {
  return {
    id: `${m.rec.id}:${m.rgId}`,
    title: m.title,
    artist: m.artist,
    album: m.album,
    year: yearOf(rgDateCache.get(m.rgId) || m.earliestDate),
    trackNumber: m.trackNumber,
    albumArtUrl: rgCoverUrl(m.rgId),
    score: m.score,
    reason: m.reason,
  };
}

/** Ranked candidates for one file (Retag match picker + auto-tagging). */
export async function searchMusicBrainzCandidates(
  parsed: ParsedFilename,
  log: Logger = noop,
  limit = 8
): Promise<ProviderCandidate[]> {
  const recs = await findRecordings(parsed.rawTitle, parsed.rawArtist, log);
  const matches = rankMatches(recs, parsed.rawTitle, parsed.rawArtist, parsed.rawAlbum).slice(0, limit);
  await loadReleaseGroupDates(matches.map((m) => m.rgId), log);
  return matches.map(matchToCandidate);
}

export async function fetchFromMusicBrainz(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<TrackMetadata | null> {
  log(`  parsed → title="${parsed.rawTitle}"${parsed.rawArtist ? ` artist="${parsed.rawArtist}"` : ' (no artist)'}${parsed.rawAlbum ? ` album="${parsed.rawAlbum}"` : ''}`);

  const candidates = await searchMusicBrainzCandidates(parsed, log, 5);
  if (candidates.length === 0) {
    log('  ✗ no candidates returned by MusicBrainz');
    return null;
  }
  log('  top matches:');
  candidates.forEach((c, i) =>
    log(`    ${i + 1}. ${c.score} "${c.title}" — ${c.artist} [${c.album}${c.year ? `, ${c.year}` : ''}] (${c.reason})`)
  );

  const best = candidates[0];
  if (best.score < MIN_CONFIDENCE) {
    log(`  ⚠ top score ${best.score} below threshold ${MIN_CONFIDENCE} — skipping (no reliable match)`);
    return null;
  }
  log(`  ✓ chosen: "${best.title}" — ${best.artist} [${best.album}]${best.trackNumber ? ` #${best.trackNumber}` : ''} (score ${best.score})`);

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

// ─── Songs tab ───────────────────────────────────────────────────────────────
const SONG_PAGE = 10;
const songCache = new Map<string, SongResult[]>();

/** Split "Artist - Title" (or "Artist – Title"); null when there's no separator. */
function splitArtistTitle(q: string): { artist: string; title: string } | null {
  const m = q.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

async function rankSongs(q: string, log: Logger): Promise<SongResult[]> {
  const split = splitArtistTitle(q);
  let recs: MBRecording[];
  let matches: Match[];

  if (split) {
    recs = await findRecordings(split.title, split.artist, log);
    matches = rankMatches(recs, split.title, split.artist);
  } else {
    // Free text: we don't know which words are the artist, so ask for both
    // readings ("words in title AND words in artist", and "it's all title").
    const byId = new Map<string, MBRecording>();
    const queries = [`recording:${bag(q)} AND artist:${bag(q)}`, `recording:${phrase(q)}`];
    for (const query of queries) {
      for (const r of await searchRecordings(query, log)) if (!byId.has(r.id)) byId.set(r.id, r);
    }
    if (byId.size === 0) for (const r of await searchRecordings(`recording:${bag(q)}`, log)) byId.set(r.id, r);
    recs = [...byId.values()];
    matches = rankMatches(recs, q, undefined);
  }

  matches = matches.filter((m) => m.score >= 35).slice(0, 40);
  await loadReleaseGroupDates(matches.map((m) => m.rgId), log);
  return matches.map((m) => ({
    title: m.title,
    artist: m.artist,
    album: m.album,
    year: yearOf(rgDateCache.get(m.rgId) || m.earliestDate),
    trackNumber: m.trackNumber,
    albumArtUrl: rgCoverUrl(m.rgId),
    durationMs: m.rec.length,
  }));
}

/** Search MusicBrainz for a song; each distinct album it appears on is a result. */
export async function searchMusicBrainzSongs(
  q: string,
  log: Logger = noop,
  offset = 0
): Promise<{ songs: SongResult[]; nextOffset: number; hasMore: boolean }> {
  const key = norm(q);
  let all = songCache.get(key);
  if (!all) {
    all = await rankSongs(q, log);
    songCache.set(key, all);
    if (songCache.size > 30) songCache.delete(songCache.keys().next().value as string);
  }
  const songs = all.slice(offset, offset + SONG_PAGE);
  const nextOffset = offset + songs.length;
  return { songs, nextOffset, hasMore: nextOffset < all.length };
}

// ─── Albums tab ──────────────────────────────────────────────────────────────
function albumKindAdj(rg: MBReleaseGroup): number {
  const primary = rg['primary-type'];
  const secondary = rg['secondary-types'] ?? [];
  let p = 0;
  if (primary === 'EP') p -= 4;
  else if (primary === 'Single') p -= 10;
  else if (primary !== 'Album') p -= 12;
  if (secondary.includes('Compilation')) p -= 8;
  if (secondary.includes('Live')) p -= 10;
  if (secondary.some((s) => s === 'Remix' || s === 'DJ-mix' || s === 'Demo' || s === 'Interview')) p -= 10;
  if (COVER_ACT_RE.test(`${rg.title ?? ''} ${creditString(rg['artist-credit'])}`)) p -= 20;
  return p;
}

/** Search MusicBrainz for albums ("in utero", "nirvana in utero", "Nirvana - In Utero"). */
export async function searchMusicBrainzAlbums(q: string, limit = 12, log: Logger = noop): Promise<AlbumResult[]> {
  const split = splitArtistTitle(q);
  const queries = split
    ? [`releasegroup:${phrase(split.title)} AND artist:${phrase(split.artist)}`, `releasegroup:${bag(split.title)} AND artist:${bag(split.artist)}`]
    : [`releasegroup:${bag(q)} AND artist:${bag(q)}`, `releasegroup:${phrase(q)}`];

  const byId = new Map<string, MBReleaseGroup>();
  for (const query of queries) {
    log(`  MB query: ${query}`);
    const data = await mbGet<{ 'release-groups'?: MBReleaseGroup[] }>('/release-group', { query, limit: 50 }, log);
    for (const rg of data['release-groups'] ?? []) if (!byId.has(rg.id)) byId.set(rg.id, rg);
    if (split && byId.size > 0) break;
  }
  if (byId.size === 0) {
    const data = await mbGet<{ 'release-groups'?: MBReleaseGroup[] }>('/release-group', { query: `releasegroup:${bag(q)}`, limit: 50 }, log);
    for (const rg of data['release-groups'] ?? []) byId.set(rg.id, rg);
  }

  const groups = [...byId.values()];
  const maxCount = Math.max(1, ...groups.map((g) => g.count ?? 1));
  const scored = groups.map((rg) => {
    const credit = creditString(rg['artist-credit']);
    const title = rg.title ?? '';
    const pop = Math.log(1 + (rg.count ?? 1)) / Math.log(1 + maxCount);
    let s: number;
    if (split) {
      s = 60 * similarity(title, split.title) + 30 * artistSimilarity(rg['artist-credit'], split.artist);
    } else {
      // Best of "all words are the album" and "artist words + album words".
      s = 60 * similarity(title, q) + 15 * pop;
      const qt = tokens(q);
      for (const c of rg['artist-credit'] ?? []) {
        const at = tokens(c.name);
        if (!at.length || at.length >= qt.length) continue;
        const rest = qt.join(' ').replace(at.join(' '), ' ').trim();
        if (rest.length < qt.join(' ').length) s = Math.max(s, 60 * similarity(title, rest) + 30);
      }
    }
    s += 10 * pop + albumKindAdj(rg);
    return { rg, credit, s };
  });

  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ rg, credit }) => ({
      id: rg.id,
      name: tidy(rg.title ?? ''),
      artist: credit,
      year: yearOf(rg['first-release-date']),
      imageUrl: rgCoverUrl(rg.id, 250),
    }));
}

/**
 * Pick the "standard edition" of an album: official, the most common track
 * count (skips deluxe/bonus editions), then CD/digital, then earliest.
 */
function pickStandardRelease(releases: MBRelease[]): MBRelease | undefined {
  if (releases.length === 0) return undefined;
  const official = releases.filter((r) => r.status === 'Official');
  const pool = official.length ? official : releases;
  const counts = new Map<number, number>();
  for (const r of pool) {
    const n = (r.media ?? []).reduce((sum, m) => sum + (m['track-count'] ?? 0), 0);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const commonCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return pool
    .filter((r) => (r.media ?? []).reduce((sum, m) => sum + (m['track-count'] ?? 0), 0) === commonCount)
    .sort((a, b) => formatRank(a) - formatRank(b) || (a.date || '9').localeCompare(b.date || '9'))[0];
}

/** Fetch an album (release group) tracklist for the conversion pipeline. */
export async function fetchMusicBrainzAlbumTracks(
  releaseGroupId: string,
  log: Logger = noop
): Promise<{ name: string; year?: string; coverArtUrl?: string; tracks: AlbumTrack[] }> {
  const id = releaseGroupId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('That is not a MusicBrainz release-group ID.');

  const browse = await mbGet<{ releases?: MBRelease[] }>('/release', { 'release-group': id, inc: 'media', limit: 100 }, log);
  const chosen = pickStandardRelease(browse.releases ?? []);
  if (!chosen) throw new Error('That MusicBrainz album has no releases.');
  log(`  using release ${chosen.id} (${chosen.date ?? 'no date'}, ${chosen.media?.[0]?.format ?? 'unknown format'})`);

  const rel = await mbGet<MBRelease>(`/release/${chosen.id}`, { inc: 'recordings+artist-credits+release-groups' }, log);
  const albumArtist = creditString(rel['artist-credit']);
  const media = rel.media ?? [];
  // Skip video discs on CD+DVD editions.
  const audio = media.filter((m) => !/DVD|Blu-ray|VHS|Video/i.test(m.format ?? ''));
  const tracks: AlbumTrack[] = (audio.length ? audio : media)
    .flatMap((m) => m.tracks ?? [])
    .filter((t) => t.title)
    .map((t) => ({
      title: tidy(t.title ?? ''),
      artist: creditString(t['artist-credit'] ?? t.recording?.['artist-credit']) || albumArtist,
      durationMs: t.length ?? t.recording?.length ?? 0,
      uri: '',
    }));
  if (tracks.length === 0) throw new Error('That MusicBrainz release has no readable tracks.');

  const rg = rel['release-group'];
  const coverArtUrl = rel['cover-art-archive']?.front
    ? `${CAA_BASE}/release/${rel.id}/front-1200`
    : rgCoverUrl(id, 1200);
  return {
    name: tidy(rg?.title ?? rel.title),
    year: yearOf(rg?.['first-release-date'] ?? rel.date),
    coverArtUrl,
    tracks,
  };
}
