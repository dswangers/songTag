# SongTag

A local web app for building an MP3 library:

- **Download** — pull audio from a YouTube URL or playlist (yt-dlp), and optionally
  auto-tag each file the moment it finishes downloading.
- **Tag / Retag / Review** — fill in ID3 metadata from a provider (Discogs, Spotify,
  or MusicBrainz), fix bad matches, and review low-confidence tags.
- **Spotify → MP3** — convert a Spotify playlist into tagged MP3s (reads the track
  list and fetches matching audio from YouTube). Pages past the embed's 100-track
  cap when Spotify allows.
- **Albums** — search **Discogs or Spotify** for an album and download the whole
  thing as tagged MP3s.

## Song library

The MP3 library isn't stored in this repo. It lives in Google Drive:

- [Song library (Google Drive)](https://drive.google.com/drive/folders/1-mWYjWTXxjWJj9CFujkcxUU91HygcjSs?usp=sharing)

Download it into a local `music/` folder (gitignored) to use with the app.

## Setup

```bash
npm install
cp .env.example .env   # fill in your API keys
npm run ui             # start the web UI
```

## Metadata providers

Set `API_PROVIDER` in `.env` to choose where tags come from:

- **`discogs`** — rich release database. Generate a free personal access token at
  [discogs.com/settings/developers](https://www.discogs.com/settings/developers) and
  put it in `.env` as `DISCOGS_TOKEN`. Authenticated requests get 60/min.
- **`spotify`** — great metadata, but subject to Spotify API rate limits.
- **`musicbrainz`** — free, no key required (sparser database).

The provider is used by the **Tag**, **Retag**, **Spotify → MP3**, and **Albums**
tabs, plus auto-tagging on the **Download** tab. The **Albums** tab can search
either Discogs or Spotify regardless of the configured tagging provider.

## Scripts

- `npm run ui` — start the web UI (`src/server.ts`)
- `npm run tag` — run the CLI tagger (`src/index.ts`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server

## Notes

The local `music/` library and secrets (`.env`, `.spotify-token.json`) are excluded from this repo.
