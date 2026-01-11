// YouTube InnerTube API wrapper
// This uses YouTube's internal API which requires session cookies

export interface Video {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  thumbnail: string;
  duration: string;
  publishedAt: string;
  setVideoId?: string; // Unique ID for playlist item (needed for removal)
}

export interface Playlist {
  id: string;
  title: string;
  videoCount: number;
  thumbnail?: string;
}

interface InnerTubeContext {
  client: {
    clientName: string;
    clientVersion: string;
    hl: string;
    gl: string;
  };
}

// Extract SAPISIDHASH for authentication
async function getSapisidHash(sapisid: string, origin: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${timestamp} ${sapisid} ${origin}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-1', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${timestamp}_${hashHex}`;
}

// Get cookies from the browser
async function getYouTubeCookies(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: '.youtube.com' }, (cookies) => {
      const cookieMap: Record<string, string> = {};
      cookies.forEach(cookie => {
        cookieMap[cookie.name] = cookie.value;
      });
      resolve(cookieMap);
    });
  });
}

// Build InnerTube context
function buildContext(): InnerTubeContext {
  return {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20250109.00.00',
      hl: 'en',
      gl: 'US',
    },
  };
}

// Build Cookie header from cookie map
function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

// Make authenticated InnerTube API request
async function innertubeRequest(endpoint: string, body: object): Promise<any> {
  const cookies = await getYouTubeCookies();
  const sapisid = cookies['SAPISID'] || cookies['__Secure-3PAPISID'];

  if (!sapisid) {
    throw new Error('Not logged into YouTube. Please log in at youtube.com first.');
  }

  const origin = 'https://www.youtube.com';
  const authHeader = await getSapisidHash(sapisid, origin);

  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;

  // Build Cookie header manually - service workers don't send credentials automatically
  const cookieHeader = buildCookieHeader(cookies);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Cookie': cookieHeader,
      'X-Origin': origin,
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': '2.20250109.00.00',
    },
    body: JSON.stringify({
      context: buildContext(),
      ...body,
    }),
  });

  if (!response.ok) {
    throw new Error(`InnerTube API error: ${response.status}`);
  }

  return response.json();
}

// Parse video item from InnerTube response
function parseVideoItem(item: any): Video | null {
  const renderer = item.playlistVideoRenderer || item.playlistPanelVideoRenderer;
  if (!renderer) return null;

  const videoId = renderer.videoId;
  if (!videoId) return null;

  return {
    id: videoId,
    title: renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || 'Unknown',
    channel: renderer.shortBylineText?.runs?.[0]?.text || 'Unknown',
    channelId: renderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
    thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration: renderer.lengthText?.simpleText || renderer.lengthText?.runs?.[0]?.text || '',
    publishedAt: renderer.publishedTimeText?.simpleText || '',
    setVideoId: renderer.setVideoId,
  };
}

// Fetch Watch Later playlist
export async function getWatchLater(): Promise<Video[]> {
  const videos: Video[] = [];
  let continuation: string | null = null;

  // Initial request
  const initialData = await innertubeRequest('browse', {
    browseId: 'VLWL',
  });

  // Parse videos from initial response
  const contents = initialData.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
  
  for (const item of contents) {
    if (item.playlistVideoRenderer) {
      const video = parseVideoItem(item);
      if (video) videos.push(video);
    }
    if (item.continuationItemRenderer) {
      continuation = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
    }
  }

  // Fetch continuations
  while (continuation) {
    const contData = await innertubeRequest('browse', {
      continuation,
    });

    const contContents = contData.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
    continuation = null;

    for (const item of contContents) {
      if (item.playlistVideoRenderer) {
        const video = parseVideoItem(item);
        if (video) videos.push(video);
      }
      if (item.continuationItemRenderer) {
        continuation = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
      }
    }
  }

  return videos;
}

// Fetch user's playlists
export async function getUserPlaylists(): Promise<Playlist[]> {
  const playlists: Playlist[] = [];

  const data = await innertubeRequest('browse', {
    browseId: 'FElibrary',
  });

  // Navigate to playlists section
  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  
  for (const tab of tabs) {
    const sections = tab.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      const items = section.itemSectionRenderer?.contents?.[0]?.shelfRenderer?.content?.horizontalListRenderer?.items ||
                    section.itemSectionRenderer?.contents || [];
      
      for (const item of items) {
        const renderer = item.gridPlaylistRenderer || item.playlistRenderer;
        if (renderer && renderer.playlistId && renderer.playlistId !== 'WL' && renderer.playlistId !== 'LL') {
          playlists.push({
            id: renderer.playlistId,
            title: renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || 'Unknown',
            videoCount: parseInt(renderer.videoCount || renderer.videoCountText?.runs?.[0]?.text || '0', 10),
            thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url,
          });
        }
      }
    }
  }

  // Also try guide endpoint for playlists
  try {
    const guideData = await innertubeRequest('guide', {});
    const guideItems = guideData.items || [];
    
    for (const section of guideItems) {
      const entries = section.guideCollapsibleSectionEntryRenderer?.expandableItems ||
                      section.guideSectionRenderer?.items || [];
      for (const entry of entries) {
        const playlistEntry = entry.guideEntryRenderer;
        if (playlistEntry?.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('VL')) {
          const playlistId = playlistEntry.navigationEndpoint.browseEndpoint.browseId.slice(2);
          if (playlistId && playlistId !== 'WL' && playlistId !== 'LL' && !playlists.find(p => p.id === playlistId)) {
            playlists.push({
              id: playlistId,
              title: playlistEntry.formattedTitle?.simpleText || 'Unknown',
              videoCount: 0,
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Could not fetch guide playlists:', e);
  }

  return playlists;
}

// Remove video from Watch Later
export async function removeFromWatchLater(videoId: string, setVideoId: string): Promise<boolean> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_REMOVE_VIDEO',
      }],
    });
    return true;
  } catch (e) {
    console.error('Failed to remove video:', e);
    return false;
  }
}

// Add video to playlist
export async function addToPlaylist(videoId: string, playlistId: string): Promise<boolean> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId,
      actions: [{
        addedVideoId: videoId,
        action: 'ACTION_ADD_VIDEO',
      }],
    });
    return true;
  } catch (e) {
    console.error('Failed to add to playlist:', e);
    return false;
  }
}

// Move video to top of Watch Later
export async function moveToTop(setVideoId: string): Promise<boolean> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_MOVE_VIDEO_BEFORE',
        movedSetVideoIdSuccessor: '', // Empty = move to top
      }],
    });
    return true;
  } catch (e) {
    console.error('Failed to move to top:', e);
    return false;
  }
}

// Move video to bottom of Watch Later (move before nothing = end)
export async function moveToBottom(setVideoId: string): Promise<boolean> {
  try {
    // Moving to bottom requires a different approach - we need to move it after the last item
    // For now, we'll just not implement this perfectly
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_MOVE_VIDEO_AFTER',
        movedSetVideoIdPredecessor: '', // This might not work perfectly
      }],
    });
    return true;
  } catch (e) {
    console.error('Failed to move to bottom:', e);
    return false;
  }
}

// Combined operation: Add to playlist and remove from Watch Later
export async function moveToPlaylist(videoId: string, setVideoId: string, targetPlaylistId: string): Promise<boolean> {
  const added = await addToPlaylist(videoId, targetPlaylistId);
  if (added) {
    return await removeFromWatchLater(videoId, setVideoId);
  }
  return false;
}
