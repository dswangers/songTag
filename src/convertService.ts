import * as path from 'path';
import * as fs from 'fs';
import { config } from './config';
import { parsePlaylistId } from './spotifyAuth';
import { fetchPlaylistViaEmbed, fetchAlbumViaEmbed, type EmbedTrack } from './spotifyEmbed';
import { fetchDiscogsAlbumTracks } from './providers/discogs';
import { findYouTubeCandidates } from './youtubeMatch';
import { downloadVideoToFile } from './downloadService';
import { updateId3Tags, updateAlbumArt, writeId3Tags } from './tagger';
import { tagFiles } from './tagService';
import { downloadImage } from './fetcher';

/** Metadata the user explicitly picked for a track (Songs tab selection). */
interface ForcedMeta {
  album?: string;
  year?: string;
  trackNumber?: string;
}

export type ConvertEvent =
  | { type: 'playlist'; name: string; total: number }
  | { type: 'track-start'; index: number; total: number; track: string; artist: string }
  | { type: 'debug'; track: string; message: string }
  | { type: 'matched'; track: string; videoTitle: string; channel: string; url: string; score: number }
  | { type: 'track-done'; track: string; file: string }
  | { type: 'track-skip'; track: string; reason: string }
  | { type: 'track-exists'; track: string; file: string }
  | { type: 'track-error'; track: string; error: string }
  | { type: 'playlist-file'; file: string }
  | { type: 'cancelled' }
  | { type: 'done'; ok: number; skipped: number; failed: number; exists: number; total: number };

export type ConvertEventHandler = (event: ConvertEvent) => void;

interface ConvertResult {
  status: 'ok' | 'skip' | 'error' | 'exists';
  entry?: { file: string; artist: string; title: string; durationSec: number };
}

/** Remove characters that are illegal in Windows filenames. */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/** Minimum YouTube match score to accept; below this we skip the track. */
const MIN_SCORE = 25;

async function convertTrack(
  embed: EmbedTrack,
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal,
  forcedCover?: Buffer | null,
  forcedMeta?: ForcedMeta | null
): Promise<ConvertResult> {
  const label = `${embed.artist} - ${embed.title}`;
  const log = (message: string) => onEvent({ type: 'debug', track: label, message });
  const durationSec = Math.round(embed.durationMs / 1000);
  const base = path.join(folder, safeName(label));

  try {
    // Skip if we already have this track on disk (re-running the same playlist).
    if (fs.existsSync(`${base}.mp3`)) {
      const file = path.basename(`${base}.mp3`);
      log('  already downloaded — skipping');
      onEvent({ type: 'track-exists', track: label, file });
      return { status: 'exists', entry: { file, artist: embed.artist, title: embed.title, durationSec } };
    }

    // Rank official-audio YouTube versions using the playlist's own duration.
    const ranked = (await findYouTubeCandidates(
      { title: embed.title, artist: embed.artist, durationSec },
      log,
      signal
    )).filter((c) => c.score >= MIN_SCORE);

    if (ranked.length === 0) {
      onEvent({ type: 'track-skip', track: label, reason: 'no acceptable YouTube match' });
      return { status: 'skip' };
    }

    // Try candidates best-first; fall back to the next if a download fails (403).
    let finalPath: string | null = null;
    for (let i = 0; i < Math.min(ranked.length, 3); i++) {
      if (signal?.aborted) return { status: 'skip' };
      const cand = ranked[i];
      onEvent({
        type: 'matched',
        track: label,
        videoTitle: cand.title,
        channel: cand.channel,
        url: cand.url,
        score: Math.round(cand.score),
      });
      try {
        finalPath = await downloadVideoToFile(cand.url, base, audioQuality, log, signal);
        break;
      } catch (err) {
        if (signal?.aborted) return { status: 'skip' };
        log(`  ✗ download failed (${err instanceof Error ? err.message : err}); trying next candidate…`);
      }
      if (signal?.aborted) return { status: 'skip' };
    }

    if (!finalPath) {
      onEvent({ type: 'track-error', track: label, error: 'all candidate downloads failed (YouTube 403?)' });
      return { status: 'error' };
    }

    if (forcedMeta) {
      // The user picked a specific version (Songs tab) — write exactly that
      // album / year / track# / cover instead of re-searching a provider, so the
      // chosen version (e.g. one album of a song that appears on two) is honoured.
      writeId3Tags(
        finalPath,
        {
          title: embed.title,
          artist: embed.artist,
          album: forcedMeta.album ?? '',
          year: forcedMeta.year,
          trackNumber: forcedMeta.trackNumber,
        },
        forcedCover ?? null
      );
      log(`  ✓ tagged with your selection: ${embed.artist} — ${embed.title}` +
        (forcedMeta.album ? ` [${forcedMeta.album}]` : '') +
        (forcedMeta.trackNumber ? ` #${forcedMeta.trackNumber}` : ''));
    } else {
      // Seed the authoritative title/artist as a hint (keeps yt-dlp art), then run
      // the FULL tagging workflow so the file gets album track numbers etc.
      updateId3Tags(finalPath, { title: embed.title, artist: embed.artist });
      log('  running full tagging workflow…');
      await tagFiles(
        [finalPath],
        { concurrency: 1, requestDelayMs: 0 },
        (e) => {
          if (e.type === 'debug') log(e.message);
          else if (e.type === 'success') {
            log(`  ✓ tagged: ${e.metadata.artist} — ${e.metadata.title}` +
              (e.metadata.trackNumber ? ` (track #${e.metadata.trackNumber})` : ''));
          } else if (e.type === 'no-match') {
            log('  ⚠ full-tag found no match — kept basic title/artist + yt-dlp art');
          } else if (e.type === 'error') {
            log(`  ⚠ full-tag error: ${e.error}`);
          }
        },
        signal
      );

      // Stamp the user-selected album cover on top of whatever tagging embedded.
      if (forcedCover) {
        try {
          updateAlbumArt(finalPath, forcedCover);
          log('  ✓ applied selected album cover');
        } catch (err) {
          log(`  ⚠ could not apply selected cover: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    onEvent({ type: 'track-done', track: label, file: path.basename(finalPath) });
    return {
      status: 'ok',
      entry: { file: path.basename(finalPath), artist: embed.artist, title: embed.title, durationSec },
    };
  } catch (err) {
    onEvent({ type: 'track-error', track: label, error: err instanceof Error ? err.message : String(err) });
    return { status: 'error' };
  }
}

/** Write a standard M3U8 playlist file listing the converted tracks. */
function writePlaylistFile(
  folder: string,
  playlistName: string,
  entries: Array<{ file: string; artist: string; title: string; durationSec: number }>
): string {
  const lines = ['#EXTM3U'];
  for (const e of entries) {
    lines.push(`#EXTINF:${e.durationSec},${e.artist} - ${e.title}`);
    lines.push(e.file); // relative to the playlist's own folder
  }
  const fileName = `${safeName(playlistName) || 'playlist'}.m3u8`;
  fs.writeFileSync(path.join(folder, fileName), lines.join('\n') + '\n', 'utf8');
  return fileName;
}

/** Extract a Spotify album ID from a URL, URI, or raw 22-char ID. */
export function parseAlbumId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/album[/:]([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Shared conversion loop: for each track, match the best official-audio YouTube
 * video, download, run the full tagging workflow, and finally write an M3U8
 * playlist listing everything that was fetched.
 */
async function runConversion(
  name: string,
  tracks: EmbedTrack[],
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal,
  forcedCover?: Buffer | null,
  forcedMeta?: ForcedMeta | null
): Promise<void> {
  onEvent({ type: 'playlist', name, total: tracks.length });

  let ok = 0, skipped = 0, failed = 0, exists = 0;
  const entries: Array<{ file: string; artist: string; title: string; durationSec: number }> = [];

  // Sequential: keeps the console readable and avoids parallel-request 403s.
  for (let i = 0; i < tracks.length; i++) {
    if (signal?.aborted) break;
    const track = tracks[i];
    onEvent({ type: 'track-start', index: i, total: tracks.length, track: track.title, artist: track.artist });
    const result = await convertTrack(track, folder, audioQuality, onEvent, signal, forcedCover, forcedMeta);
    if (result.status === 'ok') { ok++; if (result.entry) entries.push(result.entry); }
    else if (result.status === 'exists') { exists++; if (result.entry) entries.push(result.entry); }
    else if (result.status === 'skip') skipped++;
    else failed++;
  }

  // Write the playlist file for whatever we have so far (even if cancelled).
  if (entries.length > 0) {
    try {
      const file = writePlaylistFile(folder, name, entries);
      onEvent({ type: 'playlist-file', file });
    } catch (err) {
      onEvent({ type: 'debug', track: name, message: `⚠ could not write playlist file: ${err instanceof Error ? err.message : err}` });
    }
  }

  if (signal?.aborted) onEvent({ type: 'cancelled' });
  onEvent({ type: 'done', ok, skipped, failed, exists, total: tracks.length });
}

/**
 * Convert a Spotify playlist into tagged MP3s. Reads the track list from the
 * embed page (paging past the embed's 100-track cap when Spotify allows).
 */
export async function convertPlaylist(
  playlistInput: string,
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal
): Promise<void> {
  const id = parsePlaylistId(playlistInput);
  if (!id) throw new Error('Could not parse a Spotify playlist ID from that input.');

  fs.mkdirSync(folder, { recursive: true });

  const { name, tracks } = await fetchPlaylistViaEmbed(id, (m) => onEvent({ type: 'debug', track: 'playlist', message: m }));
  await runConversion(name, tracks, folder, audioQuality, onEvent, signal);
}

/** Convert a whole Spotify album into tagged MP3s (same pipeline as playlists). */
export async function convertAlbum(
  albumInput: string,
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal
): Promise<void> {
  const id = parseAlbumId(albumInput);
  if (!id) throw new Error('Could not parse a Spotify album ID from that input.');

  fs.mkdirSync(folder, { recursive: true });

  const { name, tracks, coverArtUrl } = await fetchAlbumViaEmbed(id);
  const cover = coverArtUrl ? await downloadImage(coverArtUrl) : null;
  await runConversion(name, tracks, folder, audioQuality, onEvent, signal, cover);
}

/** Convert a single track into a tagged MP3 (for the Songs tab). */
export async function convertSong(
  track: {
    title: string;
    artist: string;
    durationMs?: number;
    album?: string;
    year?: string;
    trackNumber?: string;
    coverArtUrl?: string;
  },
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal
): Promise<void> {
  if (!track.title) throw new Error('No song title provided.');
  fs.mkdirSync(folder, { recursive: true });
  const t: EmbedTrack = { title: track.title, artist: track.artist || '', durationMs: track.durationMs || 0, uri: '' };

  // If the user picked a specific result, honour its exact album/cover/metadata
  // instead of re-searching (so the chosen version of the song is downloaded).
  const hasSelection = !!(track.album || track.year || track.trackNumber || track.coverArtUrl);
  const cover = track.coverArtUrl ? await downloadImage(track.coverArtUrl) : null;
  const forcedMeta: ForcedMeta | null = hasSelection
    ? { album: track.album, year: track.year, trackNumber: track.trackNumber }
    : null;

  await runConversion(track.title, [t], folder, audioQuality, onEvent, signal, cover, forcedMeta);
}

/**
 * Convert a Discogs release (album) into tagged MP3s. Reads the track list
 * straight from the Discogs release — no Spotify needed.
 */
export async function convertDiscogsAlbum(
  releaseId: string,
  folder: string,
  audioQuality: string,
  onEvent: ConvertEventHandler,
  signal?: AbortSignal
): Promise<void> {
  const id = releaseId.trim().replace(/^\[?r/i, '').replace(/[^0-9]/g, '');
  if (!id) throw new Error('Could not parse a Discogs release ID from that input.');

  fs.mkdirSync(folder, { recursive: true });

  const { name, tracks, coverArtUrl } = await fetchDiscogsAlbumTracks(id, (m) => onEvent({ type: 'debug', track: 'album', message: m }));
  const cover = coverArtUrl ? await downloadImage(coverArtUrl) : null;
  if (coverArtUrl) {
    onEvent({ type: 'debug', track: 'album', message: cover ? '  using selected release cover for all tracks' : '  ⚠ could not download selected cover' });
  }
  await runConversion(name, tracks, folder, audioQuality, onEvent, signal, cover);
}
