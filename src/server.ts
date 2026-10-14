import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config';
import { scanMp3Files } from './scanner';
import { tagFiles, retagFiles, getRetagCandidates } from './tagService';
import { isFullyTagged, readExistingTags } from './tagger';
import { downloadAudio, checkDependencies } from './downloadService';
import { convertPlaylist, convertAlbum, convertDiscogsAlbum, convertSong } from './convertService';
import { searchSpotifyAlbums, searchSpotifyTracks } from './providers/spotify';
import { searchDiscogsAlbums, fetchDiscogsAlbumTracks, searchDiscogsSongs } from './providers/discogs';
import { fetchAlbumViaEmbed } from './spotifyEmbed';
import {
  getAuthorizeUrl,
  handleCallback,
  isAuthenticated,
  logout,
  getUserPlaylists,
} from './spotifyAuth';

const app = express();
const PORT = parseInt(process.env.PORT ?? '4000', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    const ms = Date.now() - start;
    const status = _res.statusCode;
    const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : status >= 200 ? '\x1b[32m' : '\x1b[36m';
    console.log(`${color}${req.method}\x1b[0m ${req.path} ${color}${status}\x1b[0m \x1b[2m${ms}ms\x1b[0m`);
  });
  next();
});

/** Initialise a Server-Sent Events stream on the given response. */
function openSse(res: Response): (event: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Track in-flight jobs so they can be cancelled from the UI.
const activeJobs = new Set<AbortController>();
function beginJob(req: Request): AbortController {
  const ac = new AbortController();
  activeJobs.add(ac);
  req.on('close', () => ac.abort()); // client disconnect also cancels
  return ac;
}
function endJob(ac: AbortController): void {
  activeJobs.delete(ac);
}

function cleanSelectedTrack(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string' || typeof raw.artist !== 'string' || typeof raw.album !== 'string') {
    return undefined;
  }

  return {
    title: raw.title,
    artist: raw.artist,
    album: raw.album,
    year: typeof raw.year === 'string' ? raw.year : undefined,
    trackNumber: typeof raw.trackNumber === 'string' ? raw.trackNumber : undefined,
    albumArtUrl: typeof raw.albumArtUrl === 'string' ? raw.albumArtUrl : undefined,
    confidence: typeof raw.score === 'number' ? raw.score : undefined,
  };
}

/** Cancel every running job (download / tag / retag / convert). */
app.post('/api/cancel', (_req: Request, res: Response) => {
  const n = activeJobs.size;
  activeJobs.forEach((ac) => ac.abort());
  activeJobs.clear();
  res.json({ cancelled: n });
});

/** Current configuration (folder + provider) for the UI header. */
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    folder: config.mp3Folder,
    provider: config.provider,
    concurrency: config.concurrency,
  });
});

/** Dependency health check (yt-dlp + ffmpeg). */
app.get('/api/health', async (_req: Request, res: Response) => {
  res.json(await checkDependencies());
});

/** List the MP3 files in the target folder with their current tags. */
app.get('/api/files', async (_req: Request, res: Response) => {
  try {
    const files = await scanMp3Files(config.mp3Folder);
    res.json({
      files: files.map((f) => {
        const t = readExistingTags(f);
        return {
          name: path.basename(f),
          tagged: !!t.trackNumber,
          artist: t.artist ?? '',
          title: t.title ?? '',
          album: t.album ?? '',
          trackNumber: t.trackNumber ?? '',
          score: t.score,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** List tagged files with low or missing confidence scores for manual review. */
app.get('/api/review', async (_req: Request, res: Response) => {
  try {
    const files = await scanMp3Files(config.mp3Folder);
    const LOW_SCORE = 80;
    const items = files
      .map((f) => {
        const t = readExistingTags(f);
        return {
          name: path.basename(f),
          tagged: !!t.trackNumber,
          artist: t.artist ?? '',
          title: t.title ?? '',
          album: t.album ?? '',
          trackNumber: t.trackNumber ?? '',
          score: t.score,
        };
      })
      .filter((f) => f.tagged && f.score !== undefined && f.score < LOW_SCORE)
      .sort((a, b) => (a.score ?? -999) - (b.score ?? -999));
    res.json({ items, threshold: LOW_SCORE });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/retag/candidates', async (req: Request, res: Response) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) {
    res.status(400).json({ error: 'No query provided.' });
    return;
  }

  try {
    res.json({ candidates: await getRetagCandidates(query) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** SSE-over-POST: re-tag a chosen set of files (from filename or override). */
app.post('/api/retag', async (req: Request, res: Response) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const send = openSse(res);
  const job = beginJob(req);

  try {
    const items = rawItems
      .filter((it: any) => it && typeof it.file === 'string')
      .map((it: any) => ({
        // basename guards against path traversal from the client
        filePath: path.join(config.mp3Folder, path.basename(it.file)),
        query: typeof it.query === 'string' ? it.query : undefined,
        selected: cleanSelectedTrack(it.selected),
      }));

    if (items.length === 0) {
      send({ type: 'done', results: [] });
      res.end();
      return;
    }

    await retagFiles(
      items,
      { concurrency: config.concurrency, requestDelayMs: config.requestDelayMs },
      send,
      job.signal
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

/**
 * SSE: download audio from a YouTube URL (or playlist) via yt-dlp.
 * EventSource only supports GET, so params come through the query string.
 */
app.get('/api/download', async (req: Request, res: Response) => {
  const url = String(req.query.url ?? '').trim();
  const playlist = String(req.query.playlist ?? 'false') === 'true';
  const audioQuality = String(req.query.quality ?? '0');
  const overwrite = String(req.query.overwrite ?? 'false') === 'true';

  const send = openSse(res);

  if (!url) {
    send({ type: 'error', message: 'No URL provided.' });
    res.end();
    return;
  }

  const job = beginJob(req);
  try {
    await downloadAudio(
      { url, folder: config.mp3Folder, playlist, audioQuality, overwrite },
      send,
      job.signal
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

/**
 * SSE: tag a specific set of just-downloaded files (used by "auto-tag after
 * download"). Files are passed by basename; anything already fully tagged is
 * skipped. Runs the normal tagging pipeline (uses yt-dlp metadata hints).
 */
app.get('/api/tag-files', async (req: Request, res: Response) => {
  const send = openSse(res);
  const job = beginJob(req);

  try {
    const raw = String(req.query.files ?? '').trim();
    const names = raw ? raw.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const includeTagged = String(req.query.all ?? 'false') === 'true';

    // basename guards against path traversal; keep only existing .mp3 files.
    let files = names
      .map((n) => path.join(config.mp3Folder, path.basename(n)))
      .filter((p) => p.toLowerCase().endsWith('.mp3') && fs.existsSync(p));
    files = Array.from(new Set(files));
    if (!includeTagged) files = files.filter((f) => !isFullyTagged(f));

    if (files.length === 0) {
      send({ type: 'done', results: [] });
      res.end();
      return;
    }

    await tagFiles(
      files,
      { concurrency: config.concurrency, requestDelayMs: config.requestDelayMs },
      send,
      job.signal
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

/**
 * SSE: tag every MP3 in the target folder.
 */
app.get('/api/tag', async (req: Request, res: Response) => {
  const send = openSse(res);
  const includeTagged = String(req.query.all ?? 'false') === 'true';
  const job = beginJob(req);

  try {
    let files = await scanMp3Files(config.mp3Folder);
    if (!includeTagged) files = files.filter((f) => !isFullyTagged(f));
    if (files.length === 0) {
      send({ type: 'done', results: [] });
      res.end();
      return;
    }
    await tagFiles(
      files,
      { concurrency: config.concurrency, requestDelayMs: config.requestDelayMs },
      send,
      job.signal
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

// ─── Spotify OAuth (for reading private playlists) ──────────────────────────
app.get('/api/spotify/status', (_req: Request, res: Response) => {
  res.json({ connected: isAuthenticated() });
});

app.get('/api/spotify/login', (_req: Request, res: Response) => {
  res.redirect(getAuthorizeUrl('songtag'));
});

app.get('/callback', async (req: Request, res: Response) => {
  const code = String(req.query.code ?? '');
  const error = String(req.query.error ?? '');
  if (error) {
    res.send(`<p>Spotify authorization failed: ${error}. You can close this tab.</p>`);
    return;
  }
  try {
    await handleCallback(code);
    res.send(
      `<body style="font-family:sans-serif;background:#0f1115;color:#1db954;padding:40px">` +
      `<h3>✓ Connected to Spotify</h3><p style="color:#8b929e">You can close this window.</p>` +
      `<script>window.close();setTimeout(()=>{document.body.innerHTML+='<p style=color:#8b929e>You may close this tab manually.</p>'},800)</script>` +
      `</body>`
    );
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post('/api/spotify/logout', (_req: Request, res: Response) => {
  logout();
  res.json({ connected: false });
});

app.get('/api/spotify/playlists', async (_req: Request, res: Response) => {
  try {
    res.json({ playlists: await getUserPlaylists() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** SSE: convert a Spotify playlist into tagged MP3s. */
app.get('/api/convert', async (req: Request, res: Response) => {
  const playlist = String(req.query.playlist ?? '').trim();
  const quality = String(req.query.quality ?? '0');
  const send = openSse(res);

  if (!playlist) {
    send({ type: 'error', message: 'No playlist provided.' });
    res.end();
    return;
  }

  const job = beginJob(req);
  try {
    await convertPlaylist(playlist, config.mp3Folder, quality, send, job.signal);
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

/** Search Spotify for albums (for the Albums tab). */
app.get('/api/spotify/search-albums', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'No search query provided.' });
    return;
  }
  try {
    res.json({ albums: await searchSpotifyAlbums(q) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Search Discogs for albums (for the Albums tab). */
app.get('/api/discogs/search-albums', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'No search query provided.' });
    return;
  }
  try {
    res.json({ albums: await searchDiscogsAlbums(q) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Search for individual tracks (for the Songs tab), from either source. */
app.get('/api/songs/search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  const source = String(req.query.source ?? 'discogs') === 'spotify' ? 'spotify' : 'discogs';
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
  if (!q) {
    res.status(400).json({ error: 'No search query provided.' });
    return;
  }
  try {
    const result = source === 'spotify'
      ? await searchSpotifyTracks(q, 10, offset)
      : await searchDiscogsSongs(q, () => {}, offset);
    res.json(result); // { songs, nextOffset, hasMore }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** SSE: convert a single track into a tagged MP3. */
app.get('/api/convert-song', async (req: Request, res: Response) => {
  const title = String(req.query.title ?? '').trim();
  const artist = String(req.query.artist ?? '').trim();
  const duration = parseInt(String(req.query.duration ?? '0'), 10) || 0;
  const quality = String(req.query.quality ?? '0');
  const album = String(req.query.album ?? '').trim() || undefined;
  const year = String(req.query.year ?? '').trim() || undefined;
  const trackNumber = String(req.query.track ?? '').trim() || undefined;
  const coverArtUrl = String(req.query.cover ?? '').trim() || undefined;
  const send = openSse(res);

  if (!title) {
    send({ type: 'error', message: 'No song provided.' });
    res.end();
    return;
  }

  const job = beginJob(req);
  try {
    await convertSong(
      { title, artist, durationMs: duration, album, year, trackNumber, coverArtUrl },
      config.mp3Folder,
      quality,
      send,
      job.signal
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

/** Album tracklist preview (name + tracks) for the Albums tab, from either source. */
app.get('/api/album-tracks', async (req: Request, res: Response) => {
  const album = String(req.query.album ?? '').trim();
  const source = String(req.query.source ?? 'spotify') === 'discogs' ? 'discogs' : 'spotify';
  if (!album) {
    res.status(400).json({ error: 'No album provided.' });
    return;
  }
  try {
    const { name, tracks } =
      source === 'discogs'
        ? await fetchDiscogsAlbumTracks(album)
        : await fetchAlbumViaEmbed(album);
    res.json({
      name,
      tracks: tracks.map((t) => ({ title: t.title, artist: t.artist, durationMs: t.durationMs })),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** SSE: convert a whole album (Spotify or Discogs) into tagged MP3s. */
app.get('/api/convert-album', async (req: Request, res: Response) => {
  const album = String(req.query.album ?? '').trim();
  const quality = String(req.query.quality ?? '0');
  const source = String(req.query.source ?? 'spotify') === 'discogs' ? 'discogs' : 'spotify';
  const send = openSse(res);

  if (!album) {
    send({ type: 'error', message: 'No album provided.' });
    res.end();
    return;
  }

  const job = beginJob(req);
  try {
    if (source === 'discogs') {
      await convertDiscogsAlbum(album, config.mp3Folder, quality, send, job.signal);
    } else {
      await convertAlbum(album, config.mp3Folder, quality, send, job.signal);
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    endJob(job);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  SongTag UI running at  http://localhost:${PORT}`);
  console.log(`  Target folder          ${config.mp3Folder}`);
  console.log(`  Metadata provider      ${config.provider}\n`);
});
