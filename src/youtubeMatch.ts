import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Logger } from './types';

const execFileAsync = promisify(execFile);

export interface YtCandidate {
  id: string;
  url: string;
  title: string;
  channel: string;
  durationSec: number;
  viewCount: number;
}

export interface YtMatch extends YtCandidate {
  score: number;
  reason: string;
}

/** Words that signal a non-official / wrong version when NOT in the track title. */
const NEGATIVE_KEYWORDS = [
  'live', 'cover', 'remix', 'karaoke', 'instrumental', 'sped up', 'sped-up',
  'slowed', 'reverb', 'nightcore', '8d', 'mashup', 'reaction', 'tutorial',
  'lesson', 'acoustic', 'demo', 'bass boosted', 'loop', 'remake', 'parody',
  'guitar', 'piano', 'drum', 'how to play', 'behind the scenes', 'making of',
  'snippet', 'teaser', 'trailer', 'concert', 'tour', 'session',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** yt-dlp's --flat-playlist JSON entry (only the fields we read). */
interface FlatEntry {
  id?: string;
  url?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
}

async function searchYouTube(query: string, n: number, signal?: AbortSignal): Promise<YtCandidate[]> {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [`ytsearch${n}:${query}`, '--flat-playlist', '-J', '--no-warnings'],
    { timeout: 45_000, maxBuffer: 20 * 1024 * 1024, signal }
  );

  const data = JSON.parse(stdout) as { entries?: FlatEntry[] };
  const entries = data.entries ?? [];

  return entries
    .filter((e) => e.id)
    .map((e) => ({
      id: e.id!,
      url: e.url ?? `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title ?? '',
      channel: e.channel ?? e.uploader ?? '',
      durationSec: Math.round(e.duration ?? 0),
      viewCount: e.view_count ?? 0,
    }));
}

/**
 * Score one candidate against the wanted track.
 * Heavily favours official audio (Topic / artist channels) and exact duration.
 */
function scoreCandidate(
  c: YtCandidate,
  want: { title: string; artist: string; durationSec: number }
): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;

  const nTitle = normalize(c.title);
  const nChannel = normalize(c.channel);
  const wTitle = normalize(want.title);
  const wArtist = normalize(want.artist);

  // ── Channel signals (strongest) ────────────────────────────────────────────
  const isTopic = /-\s*topic$/.test(c.channel.toLowerCase().trim());
  const artistInChannel = wArtist.length > 0 && nChannel.includes(wArtist);
  if (isTopic) { score += 55; reasons.push('official audio (Topic)'); }
  else if (artistInChannel) { score += 30; reasons.push('artist channel'); }

  // ── Title relevance ─────────────────────────────────────────────────────────
  const titleTokens = wTitle.split(' ').filter((t) => t.length > 1);
  const titleHit = titleTokens.length > 0 && titleTokens.every((t) => nTitle.includes(t));
  if (titleHit) { score += 18; reasons.push('title match'); }
  if (wArtist && nTitle.includes(wArtist)) { score += 8; reasons.push('artist in title'); }

  // ── Duration match (very reliable) ──────────────────────────────────────────
  if (want.durationSec > 0 && c.durationSec > 0) {
    const diff = Math.abs(c.durationSec - want.durationSec);
    if (diff <= 2) { score += 35; reasons.push('exact duration'); }
    else if (diff <= 5) { score += 20; reasons.push('≈ duration'); }
    else if (diff <= 12) { score += 5; }
    else if (diff <= 30) { score -= 20; reasons.push(`${diff}s off`); }
    else { score -= 45; reasons.push(`${diff}s off (wrong version?)`); }
  }

  // ── Negative keywords (only if not part of the real track title) ────────────
  for (const kw of NEGATIVE_KEYWORDS) {
    if (nTitle.includes(kw) && !wTitle.includes(kw)) {
      score -= 22;
      reasons.push(`-"${kw}"`);
    }
  }

  // ── Popularity tiebreaker (tiny) ────────────────────────────────────────────
  if (c.viewCount > 0) score += Math.min(5, Math.log10(c.viewCount));

  return { score, reason: reasons.join(', ') || 'no strong signals' };
}

/**
 * Find and rank YouTube matches for a track, best first. Returns [] if nothing
 * usable was found. The caller can try them in order (download fallback).
 */
export async function findYouTubeCandidates(
  want: { title: string; artist: string; durationSec: number },
  log: Logger = () => {},
  signal?: AbortSignal
): Promise<YtMatch[]> {
  const query = `${want.artist} ${want.title}`.trim();
  log(`  yt search: "${query}" (want ${want.durationSec}s)`);

  let candidates: YtCandidate[];
  try {
    candidates = await searchYouTube(query, 6, signal);
  } catch (err) {
    log(`  ✗ yt-dlp search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (candidates.length === 0) {
    log('  ✗ no YouTube results');
    return [];
  }

  const ranked = candidates
    .map((c) => ({ ...c, ...scoreCandidate(c, want) }))
    .sort((a, b) => b.score - a.score);

  ranked.slice(0, 5).forEach((c, i) => {
    log(`    ${i + 1}. score=${Math.round(c.score)} [${c.durationSec}s] "${c.title}" — ${c.channel} (${c.reason})`);
  });

  return ranked;
}

/** Convenience: highest-scoring match only (or null). */
export async function findBestYouTubeMatch(
  want: { title: string; artist: string; durationSec: number },
  log: Logger = () => {}
): Promise<YtMatch | null> {
  const ranked = await findYouTubeCandidates(want, log);
  return ranked[0] ?? null;
}
