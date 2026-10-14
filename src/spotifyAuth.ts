import SpotifyWebApi from 'spotify-web-api-node';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

const TOKEN_FILE = path.resolve('.spotify-token.json');
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];

export interface SpotifyTrack {
  name: string;
  artists: string[];
  primaryArtist: string;
  album: string;
  year?: string;
  durationMs: number;
  albumArtUrl?: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

let refreshToken: string | null = null;
let accessExpiresAt = 0;

const api = new SpotifyWebApi({
  clientId: config.spotify.clientId,
  clientSecret: config.spotify.clientSecret,
  redirectUri: config.spotify.redirectUri,
});

// Load a previously stored refresh token so the login survives restarts.
function loadToken(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (raw.refreshToken) {
      refreshToken = raw.refreshToken;
      api.setRefreshToken(raw.refreshToken);
    }
  } catch {
    /* no stored token yet */
  }
}
loadToken();

function saveToken(): void {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken }), 'utf8');
  } catch {
    /* best effort */
  }
}

export function isAuthenticated(): boolean {
  return refreshToken !== null;
}

/** URL the user visits to grant access. */
export function getAuthorizeUrl(state: string): string {
  return api.createAuthorizeURL(SCOPES, state);
}

/** Exchange the ?code= from the callback for tokens and persist the refresh token. */
export async function handleCallback(code: string): Promise<void> {
  const data = await api.authorizationCodeGrant(code);
  api.setAccessToken(data.body.access_token);
  api.setRefreshToken(data.body.refresh_token);
  refreshToken = data.body.refresh_token;
  accessExpiresAt = Date.now() + (data.body.expires_in - 60) * 1000;
  saveToken();
}

export function logout(): void {
  refreshToken = null;
  accessExpiresAt = 0;
  api.resetAccessToken();
  api.resetRefreshToken();
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
}

/** Ensure we hold a valid access token, refreshing if needed. */
async function ensureAccess(): Promise<SpotifyWebApi> {
  if (!refreshToken) throw new Error('Not connected to Spotify. Click "Connect Spotify" first.');
  if (Date.now() >= accessExpiresAt) {
    const data = await api.refreshAccessToken();
    api.setAccessToken(data.body.access_token);
    accessExpiresAt = Date.now() + (data.body.expires_in - 60) * 1000;
  }
  return api;
}

/** Extract a playlist ID from a URL, URI, or raw ID. */
export function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Search tracks using the user's OAuth token (higher rate limit than Client Credentials).
 * Returns null if the user is not connected.
 */
export async function searchTracksAsUser(
  q: string,
  limit = 10
): Promise<SpotifyApi.TrackObjectFull[] | null> {
  if (!refreshToken) return null;
  const client = await ensureAccess();
  const resp = await client.searchTracks(q, { limit });
  return resp.body.tracks?.items ?? [];
}

/** List the logged-in user's playlists (paginated). */
export async function getUserPlaylists(): Promise<PlaylistSummary[]> {
  const client = await ensureAccess();
  const out: PlaylistSummary[] = [];
  let offset = 0;
  for (;;) {
    const resp = await client.getUserPlaylists({ limit: 50, offset });
    const items = resp.body.items ?? [];
    for (const pl of items) {
      if (!pl || !pl.id) continue; // Spotify can return null/partial entries
      out.push({ id: pl.id, name: pl.name ?? '(untitled)', trackCount: pl.tracks?.total ?? 0 });
    }
    if (resp.body.next) offset += items.length || 50;
    else break;
  }
  return out;
}

/** Get the playlist name and all of its tracks. */
export async function getPlaylistTracks(
  playlistId: string
): Promise<{ name: string; tracks: SpotifyTrack[] }> {
  const client = await ensureAccess();

  const meta = await client.getPlaylist(playlistId, { fields: 'name' });
  const name = meta.body.name;

  const tracks: SpotifyTrack[] = [];
  let offset = 0;
  for (;;) {
    const resp = await client.getPlaylistTracks(playlistId, {
      limit: 100,
      offset,
      fields:
        'items(track(name,duration_ms,artists(name),album(name,release_date,images))),next',
    });

    for (const item of resp.body.items) {
      const t = item.track;
      if (!t || !('name' in t)) continue; // skip episodes / removed tracks
      const artists = (t.artists ?? []).map((a) => a.name).filter(Boolean);
      tracks.push({
        name: t.name,
        artists,
        primaryArtist: artists[0] ?? '',
        album: t.album?.name ?? '',
        year: t.album?.release_date ? t.album.release_date.slice(0, 4) : undefined,
        durationMs: t.duration_ms ?? 0,
        albumArtUrl: t.album?.images?.[0]?.url,
      });
    }

    if (resp.body.next) offset += 100;
    else break;
  }

  return { name, tracks };
}
