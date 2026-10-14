# SongTag

A local three-tab app for building an MP3 library: **download** tracks, **tag** them with metadata (MusicBrainz / Spotify), and convert Spotify playlists to MP3s.

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

The provider is used by the **Tag**, **Retag**, and **Spotify → MP3** tabs.

## Scripts

- `npm run ui` — start the web UI (`src/server.ts`)
- `npm run tag` — run the CLI tagger (`src/index.ts`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server

## Notes

The local `music/` library and secrets (`.env`, `.spotify-token.json`) are excluded from this repo.
