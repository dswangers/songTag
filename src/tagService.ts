import * as path from 'path';
import { parseFilename } from './parser';
import { fetchMetadata, downloadImage } from './fetcher';
import { writeId3Tags, readExistingTags } from './tagger';
import { readYouTubeMetadataHints, deleteInfoSidecar } from './youtubeInfo';
import { searchSpotifyCandidates } from './providers/spotify';
import { searchDiscogsCandidates } from './providers/discogs';
import { config } from './config';
import type { TagResult, TrackMetadata, ParsedFilename, ProviderCandidate } from './types';

/** "Artist - Topic" is YouTube's auto-generated music channel naming. */
function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/\s*VEVO\s*$/i, '')
    .trim();
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isLikelyUploaderArtist(artist: string): boolean {
  return /vevo$/i.test(artist.replace(/\s+/g, ''));
}

function sameLooseArtist(left: string, right: string): boolean {
  return normalizeLoose(left) === normalizeLoose(right);
}

function makeParsed(rawArtist: string | undefined, rawTitle: string, rawAlbum?: string): ParsedFilename {
  return {
    rawArtist,
    rawTitle,
    rawAlbum,
    query: [rawArtist, rawTitle, rawAlbum].filter(Boolean).join(' '),
  };
}

/**
 * Build the search hint, preferring tags embedded by yt-dlp (reliable artist)
 * and falling back to parsing the filename.
 */
async function buildQuery(filePath: string, log: (m: string) => void): Promise<ParsedFilename> {
  const filename = path.basename(filePath);
  const parsed = parseFilename(filename);
  const existing = readExistingTags(filePath);
  const youtubeHints = await readYouTubeMetadataHints(filePath, existing.sourceUrl, log);

  const embeddedArtist = existing.artist ? cleanArtist(existing.artist) : undefined;
  const hintArtist = youtubeHints?.artist ? cleanArtist(youtubeHints.artist) : undefined;
  const hintTitle = youtubeHints?.title;
  const hintAlbum = youtubeHints?.album;

  if (hintArtist && hintTitle) {
    log(
      `using YouTube music metadata -> artist="${hintArtist}" ` +
      `title="${hintTitle}"${hintAlbum ? ` album="${hintAlbum}"` : ''}`
    );
    return makeParsed(hintArtist, hintTitle, hintAlbum ?? parsed.rawAlbum);
  }

  if (embeddedArtist && (existing.title || parsed.rawTitle)) {
    const parsedEmbeddedTitle = existing.title ? parseFilename(existing.title) : undefined;
    const splitParsed = parsedEmbeddedTitle?.rawArtist
      ? parsedEmbeddedTitle
      : parsed.rawArtist
        ? parsed
        : undefined;

    if (existing.artist && isLikelyUploaderArtist(existing.artist)) {
      if (splitParsed?.rawArtist) {
        log(
          `embedded artist looks like a channel -> using parsed title ` +
          `artist="${splitParsed.rawArtist}" title="${splitParsed.rawTitle}"` +
          `${hintAlbum ? ` album="${hintAlbum}"` : ''}`
        );
        return makeParsed(splitParsed.rawArtist, splitParsed.rawTitle, hintAlbum ?? splitParsed.rawAlbum);
      }

      const titleOnly = parsedEmbeddedTitle?.rawTitle ?? existing.title ?? parsed.rawTitle;
      const album = hintAlbum ?? parsedEmbeddedTitle?.rawAlbum ?? parsed.rawAlbum;
      log(`embedded artist looks like a channel -> searching by title="${titleOnly}"`);
      return makeParsed(undefined, titleOnly, album);
    }

    if (
      parsedEmbeddedTitle?.rawArtist &&
      sameLooseArtist(embeddedArtist, parsedEmbeddedTitle.rawArtist)
    ) {
      log(
        `embedded title already includes artist -> using parsed title ` +
        `artist="${parsedEmbeddedTitle.rawArtist}" title="${parsedEmbeddedTitle.rawTitle}"` +
        `${hintAlbum ? ` album="${hintAlbum}"` : ''}`
      );
      return makeParsed(
        parsedEmbeddedTitle.rawArtist,
        parsedEmbeddedTitle.rawTitle,
        hintAlbum ?? parsedEmbeddedTitle.rawAlbum
      );
    }

    const title = parsedEmbeddedTitle?.rawTitle ?? existing.title ?? parsed.rawTitle;
    const album = hintAlbum ?? parsedEmbeddedTitle?.rawAlbum ?? parsed.rawAlbum;
    log(`using embedded tags -> artist="${embeddedArtist}" title="${title}"`);
    return makeParsed(embeddedArtist, title, album);
  }

  if (!parsed.rawArtist) {
    log('⚠ no artist in filename or embedded tags — match likely unreliable');
  }
  return parsed;
}

/**
 * Events emitted during a tagging run. Both the CLI and the web server
 * subscribe to these to render progress in their own way.
 */
export type TagEvent =
  | { type: 'start'; total: number }
  | { type: 'file-start'; filename: string; index: number; total: number }
  | { type: 'debug'; filename: string; message: string }
  | { type: 'success'; filename: string; metadata: TrackMetadata }
  | { type: 'no-match'; filename: string }
  | { type: 'error'; filename: string; error: string }
  | { type: 'cancelled' }
  | { type: 'done'; results: TagResult[] };

export type TagEventHandler = (event: TagEvent) => void;

/**
 * Process a single MP3 file: parse → fetch → download art → write tags.
 * Never throws — all errors are captured into the returned TagResult and
 * surfaced through `onEvent`.
 */
/** Core lookup→art→write step, given an already-resolved search query. */
async function tagWithParsed(
  filePath: string,
  parsed: ReturnType<typeof parseFilename>,
  onEvent: TagEventHandler
): Promise<TagResult> {
  const filename = path.basename(filePath);
  const log = (message: string) => onEvent({ type: 'debug', filename, message });

  try {
    const metadata = await fetchMetadata(parsed, log);

    if (!metadata) {
      onEvent({ type: 'no-match', filename });
      return { filePath, filename, success: false };
    }

    return tagWithMetadata(filePath, metadata, onEvent, log);
  } catch (err: unknown) {
    const error = err instanceof Error
      ? err.message
      : (err && typeof err === 'object' ? JSON.stringify(err) : String(err));
    onEvent({ type: 'error', filename, error });
    return { filePath, filename, success: false, error };
  }
}

async function tagWithMetadata(
  filePath: string,
  metadata: TrackMetadata,
  onEvent: TagEventHandler,
  log: (message: string) => void
): Promise<TagResult> {
  const filename = path.basename(filePath);
  let imageBuffer: Buffer | null = null;
  if (metadata.albumArtUrl) {
    imageBuffer = await downloadImage(metadata.albumArtUrl);
    log(imageBuffer ? `  downloaded art (${imageBuffer.length} bytes)` : '  art download failed');
  }

  writeId3Tags(filePath, metadata, imageBuffer);
  log('  tags written');

  onEvent({ type: 'success', filename, metadata });
  return { filePath, filename, success: true, metadata };
}

async function processFile(
  filePath: string,
  onEvent: TagEventHandler
): Promise<TagResult> {
  const filename = path.basename(filePath);
  const log = (message: string) => onEvent({ type: 'debug', filename, message });
  log(`raw filename: ${filename}`);
  const parsed = await buildQuery(filePath, log);
  return tagWithParsed(filePath, parsed, onEvent);
}

/**
 * Tag a file from the source's OWN metadata (SoundCloud/YouTube via yt-dlp),
 * read from the `.info.json` sidecar written at download time. The source stays
 * authoritative for title, artist (uploader as fallback) and cover artwork, but
 * the source's artist + album are ALSO fed into a provider lookup to enrich the
 * tags with a canonical album, year and track number when one is found — so the
 * file ends up with more data than the source alone provides. Falls back to the
 * normal filename-based provider lookup when no usable source metadata exists.
 */
async function processFileFromSource(
  filePath: string,
  onEvent: TagEventHandler
): Promise<TagResult> {
  const filename = path.basename(filePath);
  const log = (message: string) => onEvent({ type: 'debug', filename, message });
  log(`raw filename: ${filename}`);

  try {
    const existing = readExistingTags(filePath);
    const hints = await readYouTubeMetadataHints(filePath, existing.sourceUrl, log);
    const title = hints?.title;
    const artist = hints?.artist ?? hints?.uploader;

    if (!title) {
      log('no source metadata found — falling back to provider lookup');
      return tagWithParsed(filePath, await buildQuery(filePath, log), onEvent);
    }

    const sourceArtist = artist ? cleanArtist(artist) : '';
    const sourceAlbum = hints?.album ?? '';

    // Seed the provider with the source's artist + album so it has more to match
    // on. Any result enriches (but does not replace) the source identity.
    let provider: TrackMetadata | null = null;
    try {
      const parsed = makeParsed(sourceArtist || undefined, title, sourceAlbum || undefined);
      provider = await fetchMetadata(parsed, log);
    } catch (lookupErr) {
      log(`provider enrichment skipped: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}`);
    }

    const metadata: TrackMetadata = {
      // Source owns the track identity and its real artwork…
      title,
      artist: sourceArtist || provider?.artist || '',
      albumArtUrl: hints?.artworkUrl ?? provider?.albumArtUrl,
      // …provider fills in the structured bits the source usually lacks.
      album: sourceAlbum || provider?.album || '',
      year: hints?.year ?? provider?.year,
      trackNumber: provider?.trackNumber,
      confidence: provider?.confidence ?? 100,
    };

    log(
      `using source metadata${provider ? ' + provider enrichment' : ''} -> ` +
      `artist="${metadata.artist}" title="${metadata.title}"` +
      `${metadata.album ? ` album="${metadata.album}"` : ''}` +
      `${metadata.trackNumber ? ` track#=${metadata.trackNumber}` : ''}` +
      `${metadata.albumArtUrl ? ' +artwork' : ''}`
    );
    return tagWithMetadata(filePath, metadata, onEvent, log);
  } catch (err: unknown) {
    const error = err instanceof Error
      ? err.message
      : (err && typeof err === 'object' ? JSON.stringify(err) : String(err));
    onEvent({ type: 'error', filename, error });
    return { filePath, filename, success: false, error };
  }
}

/**
 * Run `items` through `fn` concurrently up to `limit` at a time, staggering
 * starts by `delayMs` to respect API rate limits.
 */
async function concurrentMap<T>(
  items: T[],
  limit: number,
  delayMs: number,
  fn: (item: T, index: number) => Promise<TagResult>,
  signal?: AbortSignal
): Promise<TagResult[]> {
  const results: TagResult[] = [];
  const inFlight = new Set<Promise<void>>();
  let index = 0;

  while (index < items.length || inFlight.size > 0) {
    if (signal?.aborted) { await Promise.all(inFlight); break; }
    while (inFlight.size < limit && index < items.length && !signal?.aborted) {
      const current = index++;
      const p = fn(items[current], current).then((r) => {
        results.push(r);
        inFlight.delete(p);
      });
      inFlight.add(p);

      if (delayMs > 0 && index < items.length) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  return results;
}

/**
 * Tag every file in `files`, emitting progress events as it goes.
 * Returns the full result set once complete.
 */
export async function tagFiles(
  files: string[],
  options: { concurrency: number; requestDelayMs: number; useSourceMetadata?: boolean },
  onEvent: TagEventHandler,
  signal?: AbortSignal
): Promise<TagResult[]> {
  onEvent({ type: 'start', total: files.length });

  const results = await concurrentMap(
    files,
    options.concurrency,
    options.requestDelayMs,
    (file, idx) => {
      onEvent({
        type: 'file-start',
        filename: path.basename(file),
        index: idx,
        total: files.length,
      });
      if (options.useSourceMetadata) {
        // Always clear the sidecar afterwards so it doesn't linger in the folder.
        return processFileFromSource(file, onEvent).finally(() => deleteInfoSidecar(file));
      }
      return processFile(file, onEvent);
    },
    signal
  );

  if (signal?.aborted) onEvent({ type: 'cancelled' });
  onEvent({ type: 'done', results });
  return results;
}

export interface RetagItem {
  filePath: string;
  /** Optional override search text ("Artist - Title"); defaults to the filename. */
  query?: string;
  selected?: TrackMetadata;
}

export async function getRetagCandidates(query: string): Promise<ProviderCandidate[]> {
  const parsed = parseFilename(query);
  if (config.provider === 'discogs') return searchDiscogsCandidates(parsed, () => {});
  // MusicBrainz has no candidate-picker yet; fall back to Spotify search there.
  return searchSpotifyCandidates(parsed, () => {});
}

/**
 * Re-tag specific files. Unlike the normal tag pass, this ignores the file's
 * existing (possibly wrong) embedded tags and searches from the filename — or
 * an explicit per-file override — so mistakes can actually be corrected.
 */
export async function retagFiles(
  items: RetagItem[],
  options: { concurrency: number; requestDelayMs: number },
  onEvent: TagEventHandler,
  signal?: AbortSignal
): Promise<TagResult[]> {
  onEvent({ type: 'start', total: items.length });

  const results = await concurrentMap(
    items,
    options.concurrency,
    options.requestDelayMs,
    (item, idx) => {
      const filename = path.basename(item.filePath);
      onEvent({ type: 'file-start', filename, index: idx, total: items.length });
      const log = (message: string) => onEvent({ type: 'debug', filename, message });
      if (item.selected) {
        log(
          `manual selection -> "${item.selected.title}" - ${item.selected.artist}` +
          ` [${item.selected.album}]`
        );
        return tagWithMetadata(item.filePath, item.selected, onEvent, log);
      }
      const source = item.query?.trim() || filename;
      log(`retag source: "${source}"`);
      const parsed = parseFilename(source);
      return tagWithParsed(item.filePath, parsed, onEvent);
    },
    signal
  );

  if (signal?.aborted) onEvent({ type: 'cancelled' });
  onEvent({ type: 'done', results });
  return results;
}
