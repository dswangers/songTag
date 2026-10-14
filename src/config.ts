import * as dotenv from 'dotenv';
import * as path from 'path';
import type { ApiProvider } from './types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getApiProvider(): ApiProvider {
  const raw = (process.env.API_PROVIDER ?? 'musicbrainz').toLowerCase();
  if (raw !== 'musicbrainz' && raw !== 'spotify') {
    throw new Error(`API_PROVIDER must be "musicbrainz" or "spotify", got: "${raw}"`);
  }
  return raw;
}

export const config = {
  provider: getApiProvider(),

  mp3Folder: path.resolve(process.env.MP3_FOLDER ?? './music'),

  concurrency: Math.max(1, parseInt(process.env.CONCURRENCY ?? '1', 10)),

  requestDelayMs: Math.max(0, parseInt(process.env.REQUEST_DELAY_MS ?? '1500', 10)),

  musicBrainz: {
    userAgent: process.env.MUSICBRAINZ_USER_AGENT ?? 'SongTag/1.0.0 (user@example.com)',
  },

  spotify: {
    get clientId() { return requireEnv('SPOTIFY_CLIENT_ID'); },
    get clientSecret() { return requireEnv('SPOTIFY_CLIENT_SECRET'); },
    // Must EXACTLY match a Redirect URI registered in the Spotify dashboard.
    redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:4000/callback',
  },
} as const;
