# SongTag

A local web app for building a tagged MP3 library. It finds the audio on YouTube
(or SoundCloud), downloads it as MP3, and fills in ID3 tags and album art from a
metadata provider.

## Tabs

- **Download** — download a YouTube or SoundCloud track/playlist URL as MP3.
  Optionally auto-tag each file as it finishes, either from a provider or from
  the source's own title/artist/artwork (**Use source metadata**, handy for
  SoundCloud).
- **Tag** — tag untagged files in the library from the configured provider.
- **Spotify → MP3** — convert a Spotify playlist into tagged MP3s (matches each
  track to its official audio on YouTube) and write an `.m3u8` playlist. Search
  your own playlists by name or paste a URL; the preview shows the playlist's
  cover and tracks newest-added first. Click a track to download just that song.
- **Albums** — search Discogs or Spotify for an album, preview its cover and
  tracklist, and download the whole album — or click a track to download just
  that song, tagged with that album's title, year, track number and cover.
- **Songs** — search Discogs or Spotify for a single song and download that exact
  version.
- **Retag** — re-tag any song, searching from its filename (or text you edit) so
  wrong tags get corrected. Also has a manual tagger for typing details in yourself.
- **Review** — list tagged files with a low confidence score and send them to Retag.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org/) and
  [Deno](https://deno.com/) on your `PATH` (yt-dlp needs Deno for YouTube). On
  Windows:

  ```bash
  winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno
  ```

The header of the web UI shows whether yt-dlp and ffmpeg were found. Keep yt-dlp
up to date with `yt-dlp -U` — YouTube changes often break older versions. (After a
self-update, `winget upgrade` refuses to touch yt-dlp because the file was
"modified"; just keep using `yt-dlp -U`.)

`npm install` covers the Node packages: `express` (web server), `node-id3` (ID3
tags), `spotify-web-api-node` (Spotify API), `axios` (HTTP) and `dotenv` (`.env`
loading), plus TypeScript and `ts-node` for development.

## Setup

```bash
npm install
cp .env.example .env   # fill in your API keys
npm run ui             # start the web UI
```

Then open <http://127.0.0.1:4000>. Always use the server started by `npm run ui` —
opening `public/index.html` directly (or via VS Code Live Server) breaks every
`/api` call.

Downloaded MP3s go to `./music` by default (set `MP3_FOLDER` in `.env` to change it).

## Metadata providers

Set `API_PROVIDER` in `.env` to choose where tags come from:

- **`discogs`** (recommended) — rich release database. Generate a free personal
  access token at [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
  and put it in `.env` as `DISCOGS_TOKEN`. Authenticated requests get 60/min.
- **`spotify`** — good metadata, but subject to Spotify API rate limits.
- **`musicbrainz`** — free, no key required (sparser database).

The provider is used for tagging on the **Tag**, **Retag**, **Spotify → MP3** and
**Download** tabs. **Albums** and **Songs** can search Discogs or Spotify
regardless of the configured provider (the source picker defaults to it).

## Spotify

Spotify credentials are needed for the **Spotify → MP3** tab and for Spotify
searches, even if your tagging provider isn't Spotify.

1. Create an app at the [Spotify developer dashboard](https://developer.spotify.com/dashboard).
2. Add the redirect URI `http://127.0.0.1:4000/callback` — it must be `127.0.0.1`,
   not `localhost` (Spotify rejects plain-http `localhost`).
3. Put `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REDIRECT_URI` in `.env`.
4. Click **Connect Spotify** on the Spotify → MP3 tab. The login is remembered
   in `.spotify-token.json`.

Limits of a Spotify app in development mode:

- **Your own playlists** (owned or collaborative) are read in full through your
  login, with each track's real date added — no size limit.
- **Other playlists** (e.g. Spotify's editorial ones) can only be read through the
  public embed page, which shows at most the first 100 tracks and has no date added,
  so "newest first" is approximate there. Private playlists you don't own can't be read.

## Scripts

- `npm run ui` — start the web UI (`src/server.ts`)
- `npm run tag` — run the command-line tagger on the music folder (`src/index.ts`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server

## Notes

The `music/` library and secrets (`.env`, `.spotify-token.json`) are gitignored and
not part of this repo.
