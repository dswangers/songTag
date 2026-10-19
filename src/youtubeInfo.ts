import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from './types';

const execFileAsync = promisify(execFile);

export interface YouTubeMetadataHints {
  title?: string;
  artist?: string;
  album?: string;
  /** Uploader/channel name — a fallback artist for sources like SoundCloud. */
  uploader?: string;
  /** Release year, from release_year or the upload date. */
  year?: string;
  /** Best available cover/thumbnail URL (e.g. SoundCloud track artwork). */
  artworkUrl?: string;
  /** True when the artwork is square (a real cover) rather than a 16:9 video frame. */
  artworkIsSquare?: boolean;
}

interface YtDlpThumbnail {
  url?: string;
  width?: number;
  height?: number;
  preference?: number;
}

interface YtDlpInfo {
  title?: string;
  track?: string;
  artist?: string;
  creator?: string;
  uploader?: string;
  album?: string;
  description?: string;
  release_year?: number | string;
  upload_date?: string;
  thumbnail?: string;
  thumbnails?: YtDlpThumbnail[];
}

function clean(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** SoundCloud serves small "-large" (100px) art; request the 500px variant. */
function upscaleArtwork(url: string): string {
  return url.replace(/-large(\.(?:jpg|jpeg|png|gif))(\?.*)?$/i, '-t500x500$1$2');
}

interface PickedArtwork {
  url: string;
  /** Square ≈ a real album cover; non-square ≈ a 16:9 video thumbnail. */
  square: boolean;
}

/** True/false when both dimensions are known, undefined when they are not. */
function isSquareDims(w?: number, h?: number): boolean | undefined {
  if (!w || !h) return undefined;
  return Math.abs(w - h) / Math.max(w, h) <= 0.1;
}

/**
 * Pick the best artwork from yt-dlp's thumbnails and flag whether it is a true
 * (square) cover. SoundCloud/YouTube-Music art is square; a plain YouTube video
 * only offers a 16:9 frame, which callers can choose to skip in favour of a
 * provider's real cover.
 */
function pickArtwork(info: YtDlpInfo): PickedArtwork | undefined {
  const list = (Array.isArray(info.thumbnails) ? info.thumbnails : [])
    .filter((t): t is YtDlpThumbnail & { url: string } => !!t && typeof t.url === 'string' && !!t.url.trim());

  // Prefer the largest clearly-square thumbnail — that's a real cover.
  const square = list
    .filter((t) => isSquareDims(t.width, t.height) === true)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  if (square) return { url: upscaleArtwork(square.url.trim()), square: true };

  // SoundCloud artwork URLs are square even when the JSON omits dimensions.
  const scUrl = clean(info.thumbnail) && /sndcdn\.com\/artworks/i.test(info.thumbnail!)
    ? info.thumbnail!.trim()
    : list.find((t) => /sndcdn\.com\/artworks/i.test(t.url))?.url.trim();
  if (scUrl) return { url: upscaleArtwork(scUrl), square: true };

  // Fall back to yt-dlp's chosen thumbnail (usually a 16:9 video frame).
  const single = clean(info.thumbnail);
  if (single) {
    const dims = list.find((t) => t.url === info.thumbnail);
    return { url: upscaleArtwork(single), square: isSquareDims(dims?.width, dims?.height) === true };
  }
  const best = list.slice().sort((a, b) => (b.width ?? b.preference ?? 0) - (a.width ?? a.preference ?? 0))[0];
  return best ? { url: upscaleArtwork(best.url.trim()), square: isSquareDims(best.width, best.height) === true } : undefined;
}

function hintsFromInfo(info: YtDlpInfo): YouTubeMetadataHints {
  const year = clean(info.release_year) ?? clean(info.upload_date)?.slice(0, 4);
  const art = pickArtwork(info);
  return {
    title: clean(info.track) ?? clean(info.title),
    // Provider-search artist stays artist/creator only (uploader is often a
    // label/channel); uploader is exposed separately for source-metadata mode.
    artist: clean(info.artist) ?? clean(info.creator),
    album: clean(info.album),
    uploader: clean(info.uploader),
    year,
    artworkUrl: art?.url,
    artworkIsSquare: art?.square ?? false,
  };
}

function hasAnyHint(h: YouTubeMetadataHints): boolean {
  return !!(h.title || h.artist || h.album || h.uploader || h.artworkUrl);
}

function sidecarPathFor(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.info.json`);
}

function readSidecar(filePath: string, log: Logger): YouTubeMetadataHints | undefined {
  const sidecarPath = sidecarPathFor(filePath);
  if (!fs.existsSync(sidecarPath)) return undefined;

  try {
    const info = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as YtDlpInfo;
    const hints = hintsFromInfo(info);
    if (hasAnyHint(hints)) {
      log(`source info sidecar ->${hints.artist ? ` artist="${hints.artist}"` : ''}${hints.uploader ? ` uploader="${hints.uploader}"` : ''}${hints.title ? ` title="${hints.title}"` : ''}${hints.album ? ` album="${hints.album}"` : ''}${hints.artworkUrl ? ' +artwork' : ''}`);
      return hints;
    }
  } catch (err) {
    log(`youtube info sidecar unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return undefined;
}

async function fetchInfo(url: string, log: Logger): Promise<YouTubeMetadataHints | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--dump-single-json', '--no-playlist', '--skip-download', url],
      { timeout: 45_000, maxBuffer: 20 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout) as YtDlpInfo;
    const hints = hintsFromInfo(info);
    if (hasAnyHint(hints)) {
      log(`source info url ->${hints.artist ? ` artist="${hints.artist}"` : ''}${hints.uploader ? ` uploader="${hints.uploader}"` : ''}${hints.title ? ` title="${hints.title}"` : ''}${hints.album ? ` album="${hints.album}"` : ''}${hints.artworkUrl ? ' +artwork' : ''}`);
      return hints;
    }
  } catch (err) {
    log(`youtube info unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return undefined;
}

export async function readYouTubeMetadataHints(
  filePath: string,
  sourceUrl: string | undefined,
  log: Logger
): Promise<YouTubeMetadataHints | undefined> {
  return readSidecar(filePath, log) ?? (sourceUrl ? await fetchInfo(sourceUrl, log) : undefined);
}

/** Remove the `.info.json` sidecar yt-dlp wrote for a file, if present. */
export function deleteInfoSidecar(filePath: string): void {
  try {
    const sidecarPath = sidecarPathFor(filePath);
    if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
  } catch {
    /* best effort — a leftover sidecar is harmless */
  }
}
