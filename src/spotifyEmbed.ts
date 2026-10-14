import axios from 'axios';

export interface EmbedTrack {
  title: string;
  artist: string;
  durationMs: number;
  uri: string;
}

/**
 * Read a Spotify playlist's track list from its public embed page.
 *
 * Spotify's Web API blocks reading playlist tracks for Development-mode apps
 * (returns 403), but the embed page exposes the track list with no auth.
 * Works for public playlists; private playlists return no data.
 */
export async function fetchPlaylistViaEmbed(
  playlistId: string
): Promise<{ name: string; tracks: EmbedTrack[] }> {
  const url = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const resp = await axios.get<string>(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15_000,
    responseType: 'text',
  });

  const match = resp.data.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    throw new Error('Could not read playlist from Spotify embed (is it private?).');
  }

  let entity: any;
  try {
    entity = JSON.parse(match[1]).props.pageProps.state.data.entity;
  } catch {
    throw new Error('Unexpected Spotify embed format.');
  }

  const list: any[] = entity?.trackList ?? [];
  if (list.length === 0) {
    throw new Error('Playlist has no readable tracks (private, or empty).');
  }

  const tracks: EmbedTrack[] = list
    .filter((t) => t && t.title)
    .map((t) => ({
      title: String(t.title),
      artist: String(t.subtitle ?? ''),
      durationMs: Number(t.duration ?? 0),
      uri: String(t.uri ?? ''),
    }));

  return { name: entity?.name ?? 'Playlist', tracks };
}
