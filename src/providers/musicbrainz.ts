import axios from 'axios';
import { config } from '../config';
import type { TrackMetadata, ParsedFilename, Logger } from '../types';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';

interface MBArtistCredit {
  artist: { name: string };
  name?: string;
}

interface MBRelease {
  id: string;
  title: string;
  date?: string;
  status?: string;
  'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] };
}

interface MBRecording {
  id: string;
  title: string;
  score: number;
  'artist-credit'?: MBArtistCredit[];
  releases?: MBRelease[];
}

interface MBSearchResponse {
  recordings: MBRecording[];
}

interface CAAResponse {
  images: Array<{
    approved: boolean;
    front: boolean;
    image: string;
    thumbnails: { '1200'?: string; large?: string; small?: string };
  }>;
}

const mbAxios = axios.create({
  baseURL: MB_BASE,
  headers: {
    'User-Agent': config.musicBrainz.userAgent,
    Accept: 'application/json',
  },
  timeout: 15_000,
});

const noop: Logger = () => {};

function artistName(rec: MBRecording): string {
  return rec['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
}

/** Escape Lucene special characters in user-derived query terms. */
function escapeLucene(term: string): string {
  return term.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, '\\$1');
}

async function search(query: string, log: Logger): Promise<MBRecording[]> {
  log(`  MB query: ${query}`);
  const resp = await mbAxios.get<MBSearchResponse>('/recording', {
    params: { query, limit: 25, inc: 'artist-credits+releases+release-groups', fmt: 'json' },
  });
  return resp.data.recordings ?? [];
}

/** Release titles that are really live bootlegs, e.g. "2000-02-24: Middle East…". */
const BOOTLEG_TITLE_RE = /^\s*\d{4}[-‐–]\d{2}[-‐–]\d{2}/;

/**
 * Score a release for "is this a real studio album?" preference.
 * Higher is better. Penalises compilations, live shows, and bootlegs.
 */
function releasePreference(rel: MBRelease): number {
  let p = 0;
  if (rel.status === 'Official') p += 4;
  if (rel.status === 'Bootleg') p -= 6;
  if (rel.status === 'Pseudo-Release') p -= 3;

  const primary = rel['release-group']?.['primary-type'];
  const secondary = rel['release-group']?.['secondary-types'] ?? [];
  if (primary === 'Album') p += 3;
  if (primary === 'EP') p += 2;
  if (primary === 'Single') p += 2;
  if (secondary.includes('Compilation')) p -= 3;
  if (secondary.includes('Live')) p -= 5;
  if (secondary.includes('Demo')) p -= 2;

  if (BOOTLEG_TITLE_RE.test(rel.title)) p -= 6; // date-titled live show
  if (rel.date) p += 1;
  return p;
}

function bestReleasePref(rec: MBRecording): number {
  const releases = rec.releases ?? [];
  if (releases.length === 0) return -Infinity;
  return Math.max(...releases.map(releasePreference));
}

function pickRelease(rec: MBRecording): MBRelease | undefined {
  const releases = rec.releases ?? [];
  if (releases.length === 0) return undefined;
  return [...releases].sort((a, b) => releasePreference(b) - releasePreference(a))[0];
}

export async function fetchFromMusicBrainz(
  parsed: ParsedFilename,
  log: Logger = noop
): Promise<TrackMetadata | null> {
  log(`  parsed → title="${parsed.rawTitle}"${parsed.rawArtist ? ` artist="${parsed.rawArtist}"` : ' (no artist)'}`);

  let recordings: MBRecording[] = [];

  // 1) Strongest query: title AND artist (if we parsed an artist)
  if (parsed.rawArtist) {
    recordings = await search(
      `recording:"${escapeLucene(parsed.rawTitle)}" AND artist:"${escapeLucene(parsed.rawArtist)}"`,
      log
    );
  }

  // 2) Fallback: title only
  if (recordings.length === 0) {
    if (parsed.rawArtist) log('  no artist-qualified results, retrying title-only…');
    recordings = await search(`recording:"${escapeLucene(parsed.rawTitle)}"`, log);
  }

  // 3) Last resort: free-text dismax over the whole cleaned query
  if (recordings.length === 0 && parsed.query) {
    log('  no exact results, retrying free-text…');
    recordings = await search(escapeLucene(parsed.query), log);
  }

  if (recordings.length === 0) {
    log('  ✗ no candidates returned by MusicBrainz');
    return null;
  }

  // Keep candidates with at least one release. Rank by MB text score first,
  // then by release quality so studio albums beat live bootlegs of equal score.
  const candidates = recordings
    .filter((r) => (r.releases?.length ?? 0) > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return bestReleasePref(b) - bestReleasePref(a);
    });

  log(`  ${recordings.length} candidate(s); top matches:`);
  candidates.slice(0, 5).forEach((r, i) => {
    const rel = pickRelease(r);
    log(`    ${i + 1}. score=${r.score} relPref=${bestReleasePref(r)} "${r.title}" — ${artistName(r)} [${rel?.title ?? '?'}]`);
  });

  if (candidates.length === 0) {
    log('  ✗ candidates had no releases');
    return null;
  }

  const best = candidates[0];
  const release = pickRelease(best)!;

  if (best.score < 80) {
    log(`  ⚠ low confidence (score ${best.score}) — match may be wrong`);
  }
  log(`  ✓ chosen: "${best.title}" — ${artistName(best)} [${release.title}] (score ${best.score})`);

  // Cover art (optional)
  let albumArtUrl: string | undefined;
  try {
    const caaResp = await axios.get<CAAResponse>(`${CAA_BASE}/release/${release.id}`, {
      headers: { 'User-Agent': config.musicBrainz.userAgent },
      timeout: 10_000,
    });
    const front = caaResp.data.images.find((img) => img.front && img.approved);
    const img = front ?? caaResp.data.images[0];
    if (img) {
      albumArtUrl = img.thumbnails['1200'] ?? img.thumbnails.large ?? img.image;
      log(`  cover art: found`);
    }
  } catch {
    log('  cover art: none on Cover Art Archive');
  }

  return {
    title: best.title,
    artist: artistName(best),
    album: release.title,
    year: release.date ? release.date.slice(0, 4) : undefined,
    confidence: best.score,
    albumArtUrl,
  };
}
