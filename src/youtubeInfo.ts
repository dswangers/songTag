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
}

interface YtDlpInfo {
  title?: string;
  track?: string;
  artist?: string;
  creator?: string;
  uploader?: string;
  album?: string;
  description?: string;
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hintsFromInfo(info: YtDlpInfo): YouTubeMetadataHints {
  return {
    title: clean(info.track) ?? clean(info.title),
    artist: clean(info.artist) ?? clean(info.creator),
    album: clean(info.album),
  };
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
    if (hints.title || hints.artist || hints.album) {
      log(`youtube info sidecar ->${hints.artist ? ` artist="${hints.artist}"` : ''}${hints.title ? ` title="${hints.title}"` : ''}${hints.album ? ` album="${hints.album}"` : ''}`);
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
    if (hints.title || hints.artist || hints.album) {
      log(`youtube info url ->${hints.artist ? ` artist="${hints.artist}"` : ''}${hints.title ? ` title="${hints.title}"` : ''}${hints.album ? ` album="${hints.album}"` : ''}`);
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
