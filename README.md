# SongTag

A local three-tab app for building an MP3 library: **download** tracks, **tag** them with metadata (MusicBrainz / Spotify), and convert Spotify playlists to MP3s.

## Links

- [Google Drive folder](https://drive.google.com/drive/folders/1-mWYjWTXxjWJj9CFujkcxUU91HygcjSs?usp=sharing)

## Setup

```bash
npm install
cp .env.example .env   # fill in your API keys
npm run ui             # start the web UI
```

## Scripts

- `npm run ui` — start the web UI (`src/server.ts`)
- `npm run tag` — run the CLI tagger (`src/index.ts`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server

## Notes

The local `music/` library and secrets (`.env`, `.spotify-token.json`) are excluded from this repo.
