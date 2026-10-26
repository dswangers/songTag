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
  /** Official channel (Topic / artist) AND exact title — almost surely the right upload. */
  strong: boolean;
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

/** Download/search noise words that aren't part of the real song title. */
const TITLE_NOISE = new Set([
  'mp3', 'audio', 'official', 'video', 'lyrics', 'lyric', 'hd', 'hq', '4k',
  'full', 'album', 'music', 'visualizer', 'visualiser', 'explicit', 'clean',
  'feat', 'ft', 'the', 'a', 'an',
]);

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
export function scoreCandidate(
  c: YtCandidate,
  want: { title: string; artist: string; durationSec: number }
): { score: number; reason: string; strong: boolean } {
  const reasons: string[] = [];
  let score = 0;

  const nTitle = normalize(c.title);
  const nChannel = normalize(c.channel);
  const wTitle = normalize(want.title);
  // Each credited artist on its own ("ANOTR, 54 Ultra" → ["anotr", "54 ultra"]),
  // so a multi-artist track still recognises the main artist's channel.
  const wArtists = want.artist
    .split(/,|&|\bfeat\.?\s|\bft\.?\s|\sx\s/i)
    .map(normalize)
    .filter(Boolean);

  // ── Channel signals (strongest) ────────────────────────────────────────────
  const isTopic = /-\s*topic$/.test(c.channel.toLowerCase().trim());
  const topicName = normalize(c.channel.replace(/-\s*topic\s*$/i, ''));
  const artistInChannel = wArtists.some((a) => nChannel.includes(a));
  // A Topic channel is only the official audio if it's one of the song's artists
  // — "Release - Topic" style karaoke/cover labels are Topic channels too.
  const artistTopic = isTopic && (wArtists.length === 0 || wArtists.some((a) => topicName.includes(a) || a.includes(topicName)));
  if (artistTopic) { score += 55; reasons.push('official audio (Topic)'); }
  else if (artistInChannel) { score += 30; reasons.push('artist channel'); }
  else if (isTopic) { score += 20; reasons.push('other Topic channel'); }

  // ── Title relevance (#1 priority) ───────────────────────────────────────────
  // The right song is decided by its TITLE. A title mismatch is disqualifying so
  // that a wrong song can never win on a coincidentally-matching duration.
  const titleTokens = wTitle.split(' ').filter((t) => t.length > 1 && !TITLE_NOISE.has(t));
  const matched = titleTokens.filter((t) => nTitle.includes(t)).length;
  const ratio = titleTokens.length > 0 ? matched / titleTokens.length : 0;
  if (titleTokens.length === 0) {
    /* nothing meaningful to match on; lean on channel + duration */
  } else if (ratio >= 0.999) { score += 60; reasons.push('exact title'); }
  else if (ratio >= 0.75) { score += 25; reasons.push('most of title'); }
  else if (ratio >= 0.5) { score -= 15; reasons.push('partial title'); }
  else { score -= 70; reasons.push('title mismatch'); }

  // Official audio ("Provided to YouTube by …") is titled with JUST the song name,
  // so a bare exact title on an official channel is the strongest sign of it.
  // Artist-in-title only helps third-party uploads ("Artist - Song") rank among
  // themselves — it must never lift one above the official upload.
  const official = artistTopic || artistInChannel;
  const cleanTitle = wTitle.length > 0 && nTitle === wTitle;
  if (official && cleanTitle) { score += 15; reasons.push('clean official title'); }
  else if (!official && wArtists.some((a) => nTitle.includes(a))) { score += 8; reasons.push('artist in title'); }
  const strong = official && titleTokens.length > 0 && ratio >= 0.999;

  // ── Duration match (tiebreaker only — must not override the title) ──────────
  if (want.durationSec > 0 && c.durationSec > 0) {
    const diff = Math.abs(c.durationSec - want.durationSec);
    if (diff <= 2) { score += 18; reasons.push('exact duration'); }
    else if (diff <= 5) { score += 10; reasons.push('≈ duration'); }
    else if (diff <= 12) { score += 3; }
    else if (diff <= 30) { score -= 12; reasons.push(`${diff}s off`); }
    else { score -= 25; reasons.push(`${diff}s off (wrong version?)`); }
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

  return { score, reason: reasons.join(', ') || 'no strong signals', strong };
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
  const rank = (cands: YtCandidate[]): YtMatch[] =>
    cands.map((c) => ({ ...c, ...scoreCandidate(c, want) })).sort((a, b) => b.score - a.score);
  const search = async (query: string): Promise<YtCandidate[]> => {
    log(`  yt search: ${query} (want ${want.durationSec}s)`);
    try {
      return await searchYouTube(query, 6, signal);
    } catch (err) {
      log(`  ✗ yt-dlp search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  // 1) `title artist "topic"` steers YouTube toward the official auto-generated
  //    audio (Topic / "Provided to YouTube by …" uploads).
  const candidates = await search(`${want.title} ${want.artist} "topic"`.trim());
  let ranked = rank(candidates);

  // 2) No clear official upload? Widen with the plain search and re-rank both.
  if (!ranked[0]?.strong && !signal?.aborted) {
    const seen = new Set(candidates.map((c) => c.id));
    const extra = (await search(`${want.artist} ${want.title}`.trim())).filter((c) => !seen.has(c.id));
    ranked = rank([...candidates, ...extra]);
  }

  if (ranked.length === 0) {
    log('  ✗ no YouTube results');
    return [];
  }

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
