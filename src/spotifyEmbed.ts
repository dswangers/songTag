import axios from 'axios';

export interface EmbedTrack {
  title: string;
  artist: string;
  durationMs: number;
  uri: string;
}

export interface EmbedResult {
  name: string;
  tracks: EmbedTrack[];
  coverArtUrl?: string;
}

/** Pull the largest cover-art URL out of an embed entity, if present. */
function embedCoverArt(entity: any): string | undefined {
  // Current embeds expose art as visualIdentity.image[{ url, maxWidth }];
  // older ones used coverArt.sources[{ url, width }].
  const sources = entity?.visualIdentity?.image ?? entity?.coverArt?.sources;
  if (Array.isArray(sources) && sources.length > 0) {
    const size = (x: any) => x?.maxWidth ?? x?.width ?? 0;
    const biggest = sources.reduce((a: any, b: any) => (size(b) > size(a) ? b : a));
    if (biggest?.url) return String(biggest.url);
  }
  return undefined;
}

type Logger = (message: string) => void;
const noop: Logger = () => {};

/** Pull the server-rendered entity + embed access token out of an embed page. */
async function readEmbed(kind: 'playlist' | 'album', id: string): Promise<{ entity: any; accessToken?: string }> {
  const url = `https://open.spotify.com/embed/${kind}/${id}`;
  const resp = await axios.get<string>(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15_000,
    responseType: 'text',
  });

  const match = resp.data.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    throw new Error(`Could not read ${kind} from Spotify embed (is it private?).`);
  }

  let data: any;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Unexpected Spotify embed format.');
  }

  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error(`Unexpected Spotify embed format (no ${kind} entity).`);

  const accessToken: string | undefined = data?.props?.pageProps?.state?.settings?.session?.accessToken;
  return { entity, accessToken };
}

function mapEmbedTrackList(entity: any, fallbackArtist?: string): EmbedTrack[] {
  const list: any[] = entity?.trackList ?? [];
  return list
    .filter((t) => t && t.title)
    .map((t) => ({
      title: String(t.title),
      artist: String(t.subtitle || fallbackArtist || ''),
      durationMs: Number(t.duration ?? 0),
      uri: String(t.uri ?? ''),
    }));
}

/**
 * The embed page's `trackList` is hard-capped at 100 items. When a playlist is
 * clearly longer, try to page the rest using the short-lived access token the
 * embed page ships with. This often works, but Spotify heavily rate-limits that
 * token — so any failure just leaves us with the first 100 (best effort).
 */
async function pageRemainingTracks(
  playlistId: string,
  accessToken: string,
  log: Logger
): Promise<EmbedTrack[]> {
  const extra: EmbedTrack[] = [];
  let offset = 100;
  for (let page = 0; page < 50; page++) {
    try {
      const resp = await axios.get<any>(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        {
          params: {
            offset,
            limit: 100,
            fields: 'items(track(name,duration_ms,artists(name),uri)),next',
          },
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Mozilla/5.0' },
          timeout: 15_000,
        }
      );
      const items: any[] = resp.data?.items ?? [];
      for (const item of items) {
        const t = item?.track;
        if (!t || !t.name) continue;
        const artists = (t.artists ?? []).map((a: any) => a.name).filter(Boolean);
        extra.push({
          title: String(t.name),
          artist: String(artists.join(', ')),
          durationMs: Number(t.duration_ms ?? 0),
          uri: String(t.uri ?? ''),
        });
      }
      offset += items.length || 100;
      if (!resp.data?.next || items.length === 0) break;
    } catch (err) {
      const status = (err as any)?.response?.status;
      log(
        `  ⚠ could not page past 100 tracks (Spotify ${status ?? 'error'}); ` +
        `using the first 100 only. This is a Spotify dev-mode / rate-limit restriction.`
      );
      break;
    }
  }
  return extra;
}

/**
 * Read a Spotify playlist's track list from its public embed page, paging past
 * the embed's 100-track cap when possible.
 */
export async function fetchPlaylistViaEmbed(
  playlistId: string,
  log: Logger = noop
): Promise<EmbedResult> {
  const { entity, accessToken } = await readEmbed('playlist', playlistId);
  const tracks = mapEmbedTrackList(entity);
  if (tracks.length === 0) {
    throw new Error('Playlist has no readable tracks (private, or empty).');
  }

  // A full 100 means there are very likely more — try to fetch the rest.
  if (tracks.length === 100 && accessToken) {
    log('  playlist has 100+ tracks — attempting to page the remainder…');
    const extra = await pageRemainingTracks(playlistId, accessToken, log);
    if (extra.length > 0) {
      log(`  paged ${extra.length} additional track(s) (total ${tracks.length + extra.length}).`);
      tracks.push(...extra);
    }
  }

  return { name: entity?.name ?? 'Playlist', tracks };
}

/** Read a Spotify album's track list from its public embed page. */
export async function fetchAlbumViaEmbed(albumId: string): Promise<EmbedResult> {
  const { entity } = await readEmbed('album', albumId);
  const tracks = mapEmbedTrackList(entity, entity?.subtitle);
  if (tracks.length === 0) {
    throw new Error('Album has no readable tracks.');
  }
  return { name: entity?.name ?? 'Album', tracks, coverArtUrl: embedCoverArt(entity) };
}
