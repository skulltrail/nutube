// Content script for NuTube
// This runs in the context of YouTube pages, allowing authenticated API requests

import { MessageType } from './types';

interface Video {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  thumbnail: string;
  duration: string;
  publishedAt: string;
  setVideoId?: string;
  watched?: boolean;
  progressPercent?: number;
}

interface Channel {
  id: string;
  name: string;
  thumbnail: string;
  subscriberCount: string;
  videoCount?: string;
  lastUploadText?: string;      // Raw text like "3 days ago" or "Last uploaded 3 days ago"
  lastUploadTimestamp?: number; // Computed timestamp for activity indicator
}

interface Playlist {
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

// Get SAPISID cookie from document.cookie
function getSapisidCookie(): string | null {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'SAPISID' || name === '__Secure-3PAPISID') {
      return value;
    }
  }
  return null;
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

// Make authenticated InnerTube API request
async function innertubeRequest(endpoint: string, body: object): Promise<any> {
  const sapisid = getSapisidCookie();

  if (!sapisid) {
    throw new Error('Not logged into YouTube. Please log in at youtube.com first.');
  }

  const origin = 'https://www.youtube.com';
  const authHeader = await getSapisidHash(sapisid, origin);

  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'X-Origin': origin,
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': '2.20250109.00.00',
    },
    body: JSON.stringify({
      context: buildContext(),
      ...body,
    }),
    credentials: 'include',
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
async function getWatchLater(): Promise<Video[]> {
  const videos: Video[] = [];
  let continuation: string | null = null;

  const initialData = await innertubeRequest('browse', {
    browseId: 'VLWL',
  });

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

// Parse video from various YouTube renderer types
function parseSubscriptionVideoItem(item: any): Video | null {
  // Try to find videoRenderer in various locations
  const videoRenderer =
    item.videoRenderer ||
    item.content?.videoRenderer ||  // for richItemRenderer
    item.gridVideoRenderer ||
    item.compactVideoRenderer;

  if (videoRenderer) {
    const videoId = videoRenderer.videoId;
    if (!videoId) return null;

    return {
      id: videoId,
      title: videoRenderer.title?.runs?.[0]?.text || videoRenderer.title?.simpleText || 'Unknown',
      channel: videoRenderer.ownerText?.runs?.[0]?.text ||
               videoRenderer.shortBylineText?.runs?.[0]?.text ||
               videoRenderer.longBylineText?.runs?.[0]?.text || 'Unknown',
      channelId: videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
                 videoRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
                 videoRenderer.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
      thumbnail: videoRenderer.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      duration: videoRenderer.lengthText?.simpleText || videoRenderer.lengthText?.runs?.[0]?.text || '',
      publishedAt: videoRenderer.publishedTimeText?.simpleText || videoRenderer.publishedTimeText?.runs?.[0]?.text || '',
    };
  }

  return null;
}

// Extract video count from playlist lockupViewModel
function extractPlaylistVideoCount(lockup: any): number {
  // Try multiple paths where video count might be stored

  // Path 1: Look in contentImage overlays (similar to video duration)
  const overlays = lockup.contentImage?.collectionThumbnailViewModel?.overlays ||
                   lockup.contentImage?.thumbnailViewModel?.overlays ||
                   [];

  for (const overlay of overlays) {
    // Check thumbnailOverlayBadgeViewModel
    const badges = overlay.thumbnailOverlayBadgeViewModel?.thumbnailBadges || [];
    for (const badge of badges) {
      const text = badge.thumbnailBadgeViewModel?.text || '';
      const match = text.match(/(\d+)\s*video/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Check thumbnailBottomOverlayViewModel
    const bottomBadges = overlay.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of bottomBadges) {
      const text = badge.thumbnailBadgeViewModel?.text || '';
      const match = text.match(/(\d+)\s*video/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  // Path 2: Look in contentImage.collectionThumbnailViewModel.stackedThumbnails or similar
  const collectionThumb = lockup.contentImage?.collectionThumbnailViewModel;
  if (collectionThumb) {
    // Sometimes video count is in accessibility text
    const accessibilityText = collectionThumb.accessibility?.accessibilityData?.label || '';
    const match = accessibilityText.match(/(\d+)\s*video/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // Path 3: Deep search through entire lockup for any "X videos" text
  const videoCountFromDeepSearch = findVideoCountInObject(lockup);
  if (videoCountFromDeepSearch > 0) {
    return videoCountFromDeepSearch;
  }

  return 0;
}

// Recursively search object for video count text
function findVideoCountInObject(obj: any, visited = new WeakSet()): number {
  if (!obj || typeof obj !== 'object') return 0;
  if (visited.has(obj)) return 0;
  visited.add(obj);

  // Check if this object has a text/content property with video count
  for (const key of ['text', 'content', 'simpleText', 'label']) {
    const value = obj[key];
    if (typeof value === 'string') {
      const match = value.match(/(\d+)\s*video/i);
      if (match) {
        console.log(`[NuTube] Found video count in ${key}:`, value);
        return parseInt(match[1], 10);
      }
    }
  }

  // Recursively search
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const count = findVideoCountInObject(item, visited);
      if (count > 0) return count;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const count = findVideoCountInObject(obj[key], visited);
      if (count > 0) return count;
    }
  }

  return 0;
}

// Extract duration and progress from lockupViewModel overlay structure
function extractDurationAndProgress(lockup: any): { duration: string; progressPercent: number; watched: boolean } {
  const result = { duration: '', progressPercent: 0, watched: false };

  // Duration lives in contentImage.thumbnailViewModel.overlays
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];

  for (const overlay of overlays) {
    // Path 1: thumbnailOverlayBadgeViewModel (standard duration badge)
    const badges1 = overlay.thumbnailOverlayBadgeViewModel?.thumbnailBadges || [];
    for (const badge of badges1) {
      const text = badge.thumbnailBadgeViewModel?.text;
      if (text && /^\d+:\d+/.test(text)) {
        result.duration = text;
      }
    }

    // Path 2: thumbnailBottomOverlayViewModel (when progress bar exists - indicates partial watch)
    const bottomOverlay = overlay.thumbnailBottomOverlayViewModel;
    if (bottomOverlay) {
      // Check for progress bar
      const progressBar = bottomOverlay.progressBar?.thumbnailOverlayProgressBarViewModel;
      if (progressBar?.valueRangeText) {
        // Format: "X% watched" or similar
        const match = progressBar.valueRangeText.match(/(\d+)%/);
        if (match) {
          result.progressPercent = parseInt(match[1], 10);
          result.watched = result.progressPercent >= 90;
        }
      }

      // Also check badges in bottom overlay for duration
      const badges2 = bottomOverlay.badges || [];
      for (const badge of badges2) {
        const text = badge.thumbnailBadgeViewModel?.text;
        if (text && /^\d+:\d+/.test(text)) {
          result.duration = text;
        }
      }
    }

    // Check for "WATCHED" badge in resume playback overlay
    if (overlay.thumbnailOverlayResumePlaybackRenderer) {
      result.watched = true;
      result.progressPercent = 100;
    }
  }

  return result;
}

// Parse video from lockupViewModel (newer YouTube format)
function parseLockupViewModel(lockup: any): Video | null {
  if (!lockup?.contentId) return null;

  // Skip non-video content (channels, playlists, etc.)
  const contentType = lockup.contentType;
  if (contentType && !contentType.includes('VIDEO')) return null;

  const videoId = lockup.contentId;
  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const title = metadata?.title?.content || 'Unknown';

  // Get channel name and channelId from metadata
  let channel = 'Unknown';
  let channelId = '';
  let publishedAt = '';
  const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
  for (const row of metadataRows) {
    const parts = row.metadataParts || [];
    for (const part of parts) {
      const text = part.text?.content || '';
      // Check for channel name (has navigation endpoint to channel)
      const browseEndpoint = part.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint;
      if (browseEndpoint?.browseId?.startsWith('UC')) {
        channel = text;
        channelId = browseEndpoint.browseId;
      }
      // Check for publish time (contains "ago" pattern)
      if (text.toLowerCase().includes('ago')) {
        publishedAt = text;
      }
    }
  }

  // Extract duration and progress from overlays
  const { duration, progressPercent, watched } = extractDurationAndProgress(lockup);

  return {
    id: videoId,
    title,
    channel,
    channelId,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration,
    publishedAt,
    watched,
    progressPercent,
  };
}

// Helper to recursively find videos in subscription feed structure
function findVideosInSubscriptionFeed(obj: any, videos: Video[], continuation: { token: string | null }, visited = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);

  // Check for lockupViewModel (newer YouTube format)
  if (obj.lockupViewModel) {
    const video = parseLockupViewModel(obj.lockupViewModel);
    if (video && !videos.find(v => v.id === video.id)) {
      videos.push(video);
    }
  }

  // Check for various video renderer types
  if (obj.videoRenderer || obj.gridVideoRenderer || obj.compactVideoRenderer) {
    const video = parseSubscriptionVideoItem(obj);
    if (video && !videos.find(v => v.id === video.id)) {
      videos.push(video);
    }
  }

  // Check for richItemRenderer containing videoRenderer or lockupViewModel
  if (obj.richItemRenderer) {
    const content = obj.richItemRenderer.content;
    if (content?.videoRenderer) {
      const video = parseSubscriptionVideoItem(content);
      if (video && !videos.find(v => v.id === video.id)) {
        videos.push(video);
      }
    } else if (content?.lockupViewModel) {
      const video = parseLockupViewModel(content.lockupViewModel);
      if (video && !videos.find(v => v.id === video.id)) {
        videos.push(video);
      }
    }
  }

  // Check for continuation token
  if (obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
    continuation.token = obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }

  // Recursively search arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findVideosInSubscriptionFeed(item, videos, continuation, visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      findVideosInSubscriptionFeed(obj[key], videos, continuation, visited);
    }
  }
}

// Fetch subscription feed videos (initial load)
async function getSubscriptionFeed(): Promise<Video[]> {
  const videos: Video[] = [];
  const continuation: { token: string | null } = { token: null };

  const initialData = await innertubeRequest('browse', {
    browseId: 'FEsubscriptions',
  });

  // Recursively find all videos in the response
  findVideosInSubscriptionFeed(initialData, videos, continuation);

  // Store continuation for infinite scroll
  subscriptionContinuation = continuation.token;

  console.log(`[NuTube] Initial subscription load: ${videos.length} videos, continuation: ${continuation.token ? 'present' : 'null'}`);

  return videos;
}

// Store continuation token for infinite scroll
let subscriptionContinuation: string | null = null;

// Fetch more subscription videos (for infinite scroll)
async function getMoreSubscriptions(): Promise<Video[]> {
  if (!subscriptionContinuation) {
    console.log('[NuTube] getMoreSubscriptions: No continuation token available');
    return [];
  }

  const videos: Video[] = [];
  const continuation: { token: string | null } = { token: null };

  console.log('[NuTube] getMoreSubscriptions: Fetching with continuation token');

  const contData = await innertubeRequest('browse', {
    continuation: subscriptionContinuation,
  });

  // Log the structure of the continuation response to debug
  const topKeys = Object.keys(contData || {});
  console.log('[NuTube] Continuation response top-level keys:', topKeys.join(', '));

  // Use the same recursive finder to handle all video formats including lockupViewModel
  findVideosInSubscriptionFeed(contData, videos, continuation);

  console.log(`[NuTube] getMoreSubscriptions: Found ${videos.length} videos, next continuation: ${continuation.token ? 'present' : 'null'}`);

  subscriptionContinuation = continuation.token;
  return videos;
}

// Add video to Watch Later
async function addToWatchLater(videoId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        addedVideoId: videoId,
        action: 'ACTION_ADD_VIDEO',
      }],
    });
    return { success: true };
  } catch (e: any) {
    // Treat 409 as success - YouTube often returns this but still processes the request
    if (e.message?.includes('409')) {
      return { success: true };
    }
    console.warn('[NuTube] Failed to add to Watch Later:', e.message || String(e));
    return { success: false, error: e.message || String(e) };
  }
}

// Helper to recursively find playlists in YouTube's nested structure
function findPlaylistsInObject(obj: any, playlists: Playlist[], visited = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);

  // Check for lockupViewModel (new YouTube structure)
  if (obj.lockupViewModel) {
    const lockup = obj.lockupViewModel;
    const contentId = lockup.contentId;
    const metadata = lockup.metadata?.lockupMetadataViewModel;
    const title = metadata?.title?.content;

    console.log('[NuTube] Found lockupViewModel:', {
      contentId,
      contentType: lockup.contentType,
      title,
      hasMetadata: !!metadata,
      metadataKeys: metadata ? Object.keys(metadata) : [],
    });

    // Log contentImage and other fields to find where video counts are stored
    if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
      console.log('[NuTube] Full playlist lockup:', JSON.stringify(lockup, null, 2).slice(0, 3000));
    }

    if (contentId && title && !contentId.startsWith('WL') && contentId !== 'LL') {
      // Check if it's a playlist by looking at the contentType or by the thumbnail structure
      const isPlaylist = lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' ||
                        obj.collectionThumbnailViewModel ||
                        lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId?.startsWith('VL');

      console.log('[NuTube] isPlaylist check:', { isPlaylist, contentType: lockup.contentType });

      if (isPlaylist && !playlists.find(p => p.id === contentId)) {
        // Log the full metadata structure to understand what we're working with
        console.log('[NuTube] Playlist metadata structure:', JSON.stringify(metadata, null, 2));

        // First try to extract video count from contentImage overlays (like video duration badges)
        let videoCount = extractPlaylistVideoCount(lockup);
        console.log('[NuTube] Video count from overlays:', videoCount);

        // Fallback: Extract video count from metadata rows (format: "42 videos" or similar)
        if (videoCount === 0) {
          const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
          console.log('[NuTube] metadataRows:', JSON.stringify(metadataRows, null, 2));

          for (const row of metadataRows) {
            const parts = row.metadataParts || [];
            for (const part of parts) {
              const text = part.text?.content || '';
              console.log('[NuTube] Checking text:', text);
              // Match patterns like "42 videos", "1 video", "No videos"
              const videoMatch = text.match(/(\d+)\s*video/i);
              if (videoMatch) {
                videoCount = parseInt(videoMatch[1], 10);
                console.log('[NuTube] Found videoCount in metadata:', videoCount);
                break;
              }
            }
            if (videoCount > 0) break;
          }
        }

        playlists.push({
          id: contentId,
          title: title,
          videoCount,
        });
      }
    }
  }

  // Check for gridPlaylistRenderer or playlistRenderer (old structure)
  const renderer = obj.gridPlaylistRenderer || obj.playlistRenderer;
  if (renderer?.playlistId && renderer.playlistId !== 'WL' && renderer.playlistId !== 'LL') {
    if (!playlists.find(p => p.id === renderer.playlistId)) {
      playlists.push({
        id: renderer.playlistId,
        title: renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || 'Unknown',
        videoCount: parseInt(renderer.videoCount || renderer.videoCountText?.runs?.[0]?.text || '0', 10),
        thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url,
      });
    }
  }

  // Recursively search arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findPlaylistsInObject(item, playlists, visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      findPlaylistsInObject(obj[key], playlists, visited);
    }
  }
}

// Fetch user's playlists
async function getUserPlaylists(): Promise<Playlist[]> {
  const playlists: Playlist[] = [];

  // Try FElibrary first
  const data = await innertubeRequest('browse', {
    browseId: 'FElibrary',
  });

  console.log('[NuTube] FElibrary response keys:', Object.keys(data || {}));
  console.log('[NuTube] FElibrary full response:', JSON.stringify(data, null, 2).slice(0, 5000));

  // Use recursive search to find playlists in the response
  findPlaylistsInObject(data.contents, playlists);

  // Also try the guide API as a fallback
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
              title: playlistEntry.formattedTitle?.simpleText || playlistEntry.title?.simpleText || 'Unknown',
              videoCount: 0,
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Could not fetch guide playlists:', e);
  }

  // For playlists with videoCount = 0, try fetching individual playlist details
  // to get accurate video counts
  const playlistsWithMissingCounts = playlists.filter(p => p.videoCount === 0);
  if (playlistsWithMissingCounts.length > 0) {
    console.log('[NuTube] Fetching individual playlist details for', playlistsWithMissingCounts.length, 'playlists');

    // Fetch in batches to avoid overwhelming the API
    const batchSize = 3;
    for (let i = 0; i < playlistsWithMissingCounts.length; i += batchSize) {
      const batch = playlistsWithMissingCounts.slice(i, i + batchSize);
      await Promise.all(batch.map(async (playlist) => {
        try {
          const playlistData = await innertubeRequest('browse', {
            browseId: `VL${playlist.id}`,
          });

          // Extract video count from playlist detail response
          const videoCount = extractVideoCountFromPlaylistDetails(playlistData);
          if (videoCount > 0) {
            playlist.videoCount = videoCount;
            console.log('[NuTube] Got video count for', playlist.title, ':', videoCount);
          }
        } catch (e) {
          console.warn('[NuTube] Failed to fetch playlist details for', playlist.id, e);
        }
      }));
    }
  }

  return playlists;
}

// Extract video count from individual playlist browse response
function extractVideoCountFromPlaylistDetails(data: any): number {
  // Try header -> playlistSidebarPrimaryInfoRenderer -> stats
  const header = data?.header;

  // Pattern 1: playlistHeaderRenderer (common for playlists)
  const playlistHeader = header?.playlistHeaderRenderer;
  if (playlistHeader) {
    // Try stats array
    const stats = playlistHeader.stats || [];
    for (const stat of stats) {
      const text = stat.runs?.[0]?.text || stat.simpleText || '';
      const match = text.match(/(\d+)/);
      if (match && text.toLowerCase().includes('video')) {
        return parseInt(match[1], 10);
      }
      // Sometimes just the number is in runs, e.g., "42" followed by " videos"
      if (match && stats.length > 0) {
        const fullText = stats.map((s: any) =>
          s.runs?.map((r: any) => r.text).join('') || s.simpleText || ''
        ).join(' ');
        const videoMatch = fullText.match(/(\d+)\s*video/i);
        if (videoMatch) {
          return parseInt(videoMatch[1], 10);
        }
      }
    }

    // Try numVideosText
    const numVideosText = playlistHeader.numVideosText?.runs?.[0]?.text ||
                          playlistHeader.numVideosText?.simpleText || '';
    const numMatch = numVideosText.match(/(\d+)/);
    if (numMatch) {
      return parseInt(numMatch[1], 10);
    }
  }

  // Pattern 2: Try sidebar
  const sidebar = data?.sidebar?.playlistSidebarRenderer?.items || [];
  for (const item of sidebar) {
    const primaryInfo = item.playlistSidebarPrimaryInfoRenderer;
    if (primaryInfo?.stats) {
      for (const stat of primaryInfo.stats) {
        const text = stat.runs?.map((r: any) => r.text).join('') || stat.simpleText || '';
        const match = text.match(/(\d+)\s*video/i);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    }
  }

  // Pattern 3: Deep search as fallback
  return findVideoCountInObject(data);
}

// Remove video from Watch Later
async function removeFromWatchLater(videoId: string, setVideoId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_REMOVE_VIDEO',
      }],
    });
    return { success: true };
  } catch (e: any) {
    // YouTube often returns 409 (Conflict) but still processes the request successfully
    // Treat 409 as success since the action typically completes
    if (e.message?.includes('409')) {
      return { success: true };
    }
    console.warn('Remove video error:', e.message);
    return { success: false, error: e.message || String(e) };
  }
}

// Add video to playlist
async function addToPlaylist(videoId: string, playlistId: string): Promise<boolean> {
  try {
    await innertubeRequest('browse/edit_playlist', {
      playlistId,
      actions: [{
        addedVideoId: videoId,
        action: 'ACTION_ADD_VIDEO',
      }],
    });
    return true;
  } catch (e: any) {
    // Treat 409 as success - YouTube often returns this but still processes the request
    if (e.message?.includes('409')) {
      return true;
    }
    console.warn('Add to playlist error:', e.message);
    return false;
  }
}

// Move video to top of Watch Later
async function moveToTop(setVideoId: string, firstSetVideoId?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // If no firstSetVideoId provided, or video is already first, skip
    if (!firstSetVideoId || setVideoId === firstSetVideoId) {
      return { success: true };
    }
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_MOVE_VIDEO_BEFORE',
        movedSetVideoIdSuccessor: firstSetVideoId,
      }],
    });
    return { success: true };
  } catch (e: any) {
    // Treat 409 as success - YouTube often returns this but still processes the request
    if (e.message?.includes('409')) {
      return { success: true };
    }
    console.warn('Move to top error:', e.message);
    return { success: false, error: e.message || String(e) };
  }
}

// Move video to bottom of Watch Later
async function moveToBottom(setVideoId: string, lastSetVideoId?: string): Promise<{ success: boolean; error?: string }> {
  try {
    // If no lastSetVideoId provided, or video is already last, skip
    if (!lastSetVideoId || setVideoId === lastSetVideoId) {
      return { success: true };
    }
    await innertubeRequest('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{
        setVideoId,
        action: 'ACTION_MOVE_VIDEO_AFTER',
        movedSetVideoIdPredecessor: lastSetVideoId,
      }],
    });
    return { success: true };
  } catch (e: any) {
    // Treat 409 as success - YouTube often returns this but still processes the request
    if (e.message?.includes('409')) {
      return { success: true };
    }
    console.warn('Move to bottom error:', e.message);
    return { success: false, error: e.message || String(e) };
  }
}

// Combined operation: Add to playlist and remove from Watch Later
async function moveToPlaylist(videoId: string, setVideoId: string, targetPlaylistId: string): Promise<boolean> {
  const added = await addToPlaylist(videoId, targetPlaylistId);
  if (added) {
    const result = await removeFromWatchLater(videoId, setVideoId);
    return result.success;
  }
  return false;
}

// Store continuation for channels infinite scroll
let channelsContinuation: string | null = null;

// Parse relative time text (e.g., "3 days ago") to timestamp
function parseRelativeTime(text: string): number | undefined {
  if (!text) return undefined;

  const now = Date.now();
  const lowerText = text.toLowerCase();

  // Extract number and unit
  const match = lowerText.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (!match) {
    // Check for "streamed X ago" or "Last uploaded X ago" patterns
    const altMatch = lowerText.match(/(?:streamed|uploaded)\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
    if (!altMatch) return undefined;
    const [, num, unit] = altMatch;
    return computeTimestamp(now, parseInt(num, 10), unit);
  }

  const [, num, unit] = match;
  return computeTimestamp(now, parseInt(num, 10), unit);
}

function computeTimestamp(now: number, num: number, unit: string): number {
  const msPerUnit: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };
  return now - num * (msPerUnit[unit] || 0);
}

// Get subscribed channels
async function getSubscribedChannels(): Promise<Channel[]> {
  const channels: Channel[] = [];
  const continuation: { token: string | null } = { token: null };

  const data = await innertubeRequest('browse', {
    browseId: 'FEchannels',
  });

  // Find channels in the response
  findChannelsInGuide(data, channels, continuation);

  channelsContinuation = continuation.token;
  return channels;
}

// Get more subscribed channels (for infinite scroll)
async function getMoreChannels(): Promise<Channel[]> {
  if (!channelsContinuation) {
    return [];
  }

  const channels: Channel[] = [];
  const continuation: { token: string | null } = { token: null };

  const contData = await innertubeRequest('browse', {
    continuation: channelsContinuation,
  });

  findChannelsInGuide(contData, channels, continuation);

  channelsContinuation = continuation.token;
  return channels;
}

// Extract activity info from various possible locations in channel data
function extractActivityInfo(obj: any): { lastUploadText?: string; lastUploadTimestamp?: number } {
  let lastUploadText: string | undefined;
  let lastUploadTimestamp: number | undefined;

  // Helper to check if text contains time-ago pattern
  const checkForAgo = (text: string) => {
    if (text && text.toLowerCase().includes('ago')) {
      lastUploadText = text;
      lastUploadTimestamp = parseRelativeTime(text);
      return true;
    }
    return false;
  };

  // Check various fields that might contain activity info
  const fieldsToCheck = [
    obj.videoCountText?.simpleText,
    obj.videoCountText?.runs?.[0]?.text,
    obj.secondaryText?.simpleText,
    obj.secondaryText?.runs?.[0]?.text,
    obj.subtitle?.simpleText,
    obj.subtitle?.runs?.[0]?.text,
    obj.descriptionSnippet?.simpleText,
    obj.descriptionSnippet?.runs?.[0]?.text,
  ];

  for (const field of fieldsToCheck) {
    if (field && checkForAgo(field)) break;
  }

  // Check for status badges or overlays
  const badges = obj.ownerBadges || obj.badges || [];
  for (const badge of badges) {
    const badgeText = badge.metadataBadgeRenderer?.label ||
                      badge.liveBroadcastBadgeRenderer?.label?.simpleText || '';
    if (checkForAgo(badgeText)) break;
  }

  return { lastUploadText, lastUploadTimestamp };
}

// Helper to find channels in YouTube's subscription guide structure
function findChannelsInGuide(obj: any, channels: Channel[], continuation: { token: string | null }, visited = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);

  // Check for channel renderer (gridChannelRenderer or channelRenderer)
  const renderer = obj.gridChannelRenderer || obj.channelRenderer;
  if (renderer?.channelId) {
    const channelId = renderer.channelId;
    if (!channels.find(c => c.id === channelId)) {
      const videoCountText = renderer.videoCountText?.simpleText || renderer.videoCountText?.runs?.[0]?.text || '';
      const { lastUploadText, lastUploadTimestamp } = extractActivityInfo(renderer);

      channels.push({
        id: channelId,
        name: renderer.title?.simpleText || renderer.title?.runs?.[0]?.text || 'Unknown',
        thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url || '',
        subscriberCount: renderer.subscriberCountText?.simpleText || renderer.subscriberCountText?.runs?.[0]?.text || '',
        videoCount: videoCountText,
        lastUploadText,
        lastUploadTimestamp,
      });
    }
  }

  // Check for lockupViewModel (newer format)
  if (obj.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL') {
    const lockup = obj.lockupViewModel;
    const channelId = lockup.contentId;
    if (channelId && !channels.find(c => c.id === channelId)) {
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];

      // Extract subscriber count and look for upload time in metadata rows
      let subscriberCount = '';
      let lastUploadText: string | undefined;
      let lastUploadTimestamp: number | undefined;

      for (const row of metadataRows) {
        const parts = row.metadataParts || [];
        for (const part of parts) {
          const text = part.text?.content || '';
          if (text.toLowerCase().includes('subscriber')) {
            subscriberCount = text;
          } else if (text.toLowerCase().includes('ago')) {
            lastUploadText = text;
            lastUploadTimestamp = parseRelativeTime(text);
          }
        }
      }

      // Also check subtitle if available
      const subtitle = metadata?.subtitle?.content;
      if (!lastUploadText && subtitle && subtitle.toLowerCase().includes('ago')) {
        lastUploadText = subtitle;
        lastUploadTimestamp = parseRelativeTime(subtitle);
      }

      // Check overlays for activity badges
      const overlays = lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays || [];
      for (const overlay of overlays) {
        const badgeText = overlay.thumbnailBadgeViewModel?.text ||
                         overlay.thumbnailOverlayBadgeViewModel?.text || '';
        if (!lastUploadText && badgeText.toLowerCase().includes('ago')) {
          lastUploadText = badgeText;
          lastUploadTimestamp = parseRelativeTime(badgeText);
        }
        // Check for "NEW" badge which indicates recent upload
        if (!lastUploadTimestamp && badgeText.toLowerCase() === 'new') {
          lastUploadText = 'New';
          lastUploadTimestamp = Date.now() - 12 * 60 * 60 * 1000; // Assume 12 hours for "NEW"
        }
      }

      channels.push({
        id: channelId,
        name: metadata?.title?.content || 'Unknown',
        thumbnail: lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url || '',
        subscriberCount,
        lastUploadText,
        lastUploadTimestamp,
      });
    }
  }

  // Check for continuation token
  if (obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
    continuation.token = obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }

  // Recursively search
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findChannelsInGuide(item, channels, continuation, visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      findChannelsInGuide(obj[key], channels, continuation, visited);
    }
  }
}

// Unsubscribe from a channel
async function unsubscribeFromChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await innertubeRequest('subscription/unsubscribe', {
      channelIds: [channelId],
    });
    return { success: true };
  } catch (e: any) {
    // Use warn instead of error to avoid polluting console with red errors
    console.warn('[NuTube] Unsubscribe failed:', e.message || String(e));
    return { success: false, error: e.message || String(e) };
  }
}

// Subscribe to a channel (for undo functionality)
async function subscribeToChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await innertubeRequest('subscription/subscribe', {
      channelIds: [channelId],
    });
    return { success: true };
  } catch (e: any) {
    // Treat 409 as success - already subscribed
    if (e.message?.includes('409')) {
      return { success: true };
    }
    console.warn('[NuTube] Subscribe failed:', e.message || String(e));
    return { success: false, error: e.message || String(e) };
  }
}

// Get channel suggestions (featured channels from a channel's page)
async function getChannelSuggestions(channelId: string): Promise<Channel[]> {
  const suggestions: Channel[] = [];

  try {
    // First, try fetching the channel's "channels" tab
    // The param EghjaGFubmVscw%3D%3D decodes to a protobuf for the channels tab
    const data = await innertubeRequest('browse', {
      browseId: channelId,
      params: 'EghjaGFubmVscw%3D%3D', // Base64 encoded "channels" tab param
    });

    // Find featured channels in the response
    findFeaturedChannels(data, suggestions);

    console.log(`[NuTube] Found ${suggestions.length} channels from channels tab`);

    // If no channels found, try the home tab as fallback (featured channels section)
    if (suggestions.length === 0) {
      console.log('[NuTube] No channels in channels tab, trying home tab...');
      const homeData = await innertubeRequest('browse', {
        browseId: channelId,
        // No params = home tab
      });
      findFeaturedChannels(homeData, suggestions);
      console.log(`[NuTube] Found ${suggestions.length} channels from home tab`);
    }
  } catch (e) {
    console.warn('Could not fetch channel suggestions:', e);
  }

  return suggestions;
}

// Helper to find featured channels in a channel's page
function findFeaturedChannels(obj: any, channels: Channel[], visited = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);

  // Check for gridChannelRenderer (featured channels section)
  if (obj.gridChannelRenderer?.channelId) {
    const renderer = obj.gridChannelRenderer;
    const channelId = renderer.channelId;
    if (!channels.find(c => c.id === channelId)) {
      channels.push({
        id: channelId,
        name: renderer.title?.simpleText || renderer.title?.runs?.[0]?.text || 'Unknown',
        thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url || '',
        subscriberCount: renderer.subscriberCountText?.simpleText || '',
      });
    }
  }

  // Check for lockupViewModel channel type
  if (obj.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL') {
    const lockup = obj.lockupViewModel;
    const channelId = lockup.contentId;
    if (channelId && !channels.find(c => c.id === channelId)) {
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      channels.push({
        id: channelId,
        name: metadata?.title?.content || 'Unknown',
        thumbnail: lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url || '',
        subscriberCount: metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
      });
    }
  }

  // Recursively search
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findFeaturedChannels(item, channels, visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      findFeaturedChannels(obj[key], channels, visited);
    }
  }
}

// Fetch videos from a channel's videos tab
async function getChannelVideos(channelId: string): Promise<Video[]> {
  const videos: Video[] = [];

  try {
    // Fetch the channel's videos tab
    // params is base64 for the videos tab: EgZ2aWRlb3PyBgQKAjoA
    const data = await innertubeRequest('browse', {
      browseId: channelId,
      params: 'EgZ2aWRlb3PyBgQKAjoA', // Videos tab, sorted by date
    });

    // Find videos in the response using the same recursive approach
    const continuation: { token: string | null } = { token: null };
    findVideosInChannelTab(data, videos, continuation);

    console.log(`[NuTube] Fetched ${videos.length} videos from channel ${channelId} (videos tab)`);

    // If no videos found with videos tab, try the home tab as fallback
    if (videos.length === 0) {
      console.log('[NuTube] No videos in videos tab, trying home tab...');
      const homeData = await innertubeRequest('browse', {
        browseId: channelId,
        // No params = home tab
      });
      findVideosInChannelTab(homeData, videos, continuation);
      console.log(`[NuTube] Fetched ${videos.length} videos from channel ${channelId} (home tab)`);
    }
  } catch (e) {
    console.warn('Could not fetch channel videos:', e);
  }

  return videos;
}

// Helper to find videos in a channel's videos tab
function findVideosInChannelTab(obj: any, videos: Video[], continuation: { token: string | null }, visited = new WeakSet()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);

  // Check for richItemRenderer containing video
  if (obj.richItemRenderer?.content) {
    const content = obj.richItemRenderer.content;

    // Check for videoRenderer
    if (content.videoRenderer) {
      const video = parseSubscriptionVideoItem(content);
      if (video && !videos.find(v => v.id === video.id)) {
        videos.push(video);
      }
    }

    // Check for lockupViewModel
    if (content.lockupViewModel) {
      const video = parseLockupViewModel(content.lockupViewModel);
      if (video && !videos.find(v => v.id === video.id)) {
        videos.push(video);
      }
    }
  }

  // Check for direct lockupViewModel (newer YouTube structure without wrapper)
  if (obj.lockupViewModel?.contentType?.includes('VIDEO')) {
    const video = parseLockupViewModel(obj.lockupViewModel);
    if (video && !videos.find(v => v.id === video.id)) {
      videos.push(video);
    }
  }

  // Check for direct videoRenderer (without richItemRenderer wrapper)
  if (obj.videoRenderer?.videoId) {
    const video = parseSubscriptionVideoItem(obj);
    if (video && !videos.find(v => v.id === video.id)) {
      videos.push(video);
    }
  }

  // Check for gridVideoRenderer (older format)
  if (obj.gridVideoRenderer) {
    const renderer = obj.gridVideoRenderer;
    const videoId = renderer.videoId;
    if (videoId && !videos.find(v => v.id === videoId)) {
      videos.push({
        id: videoId,
        title: renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || 'Unknown',
        channel: renderer.shortBylineText?.runs?.[0]?.text || 'Unknown',
        channelId: renderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
        thumbnail: renderer.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        duration: renderer.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '',
        publishedAt: renderer.publishedTimeText?.simpleText || '',
      });
    }
  }

  // Check for continuation token
  if (obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
    continuation.token = obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }

  // Recursively search
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findVideosInChannelTab(item, videos, continuation, visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      findVideosInChannelTab(obj[key], videos, continuation, visited);
    }
  }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'PING': {
          sendResponse({ success: true, data: 'pong' });
          break;
        }
        case 'GET_WATCH_LATER': {
          const videos = await getWatchLater();
          sendResponse({ success: true, data: videos });
          break;
        }
        case 'GET_SUBSCRIPTIONS': {
          const subVideos = await getSubscriptionFeed();
          sendResponse({ success: true, data: subVideos });
          break;
        }
        case 'GET_MORE_SUBSCRIPTIONS': {
          const moreVideos = await getMoreSubscriptions();
          sendResponse({ success: true, data: moreVideos });
          break;
        }
        case 'GET_PLAYLISTS': {
          const playlists = await getUserPlaylists();
          sendResponse({ success: true, data: playlists });
          break;
        }
        case 'REMOVE_FROM_WATCH_LATER': {
          const result = await removeFromWatchLater(message.videoId, message.setVideoId);
          sendResponse(result);
          break;
        }
        case 'ADD_TO_PLAYLIST': {
          const success = await addToPlaylist(message.videoId, message.playlistId);
          sendResponse({ success });
          break;
        }
        case 'ADD_TO_WATCH_LATER': {
          const wlResult = await addToWatchLater(message.videoId);
          sendResponse(wlResult);
          break;
        }
        case 'MOVE_TO_TOP': {
          const result = await moveToTop(message.setVideoId, message.firstSetVideoId);
          sendResponse(result);
          break;
        }
        case 'MOVE_TO_BOTTOM': {
          const result = await moveToBottom(message.setVideoId, message.lastSetVideoId);
          sendResponse(result);
          break;
        }
        case 'MOVE_TO_PLAYLIST': {
          const success = await moveToPlaylist(message.videoId, message.setVideoId, message.playlistId);
          sendResponse({ success });
          break;
        }
        case 'GET_CHANNELS': {
          const channels = await getSubscribedChannels();
          sendResponse({ success: true, data: channels });
          break;
        }
        case 'GET_MORE_CHANNELS': {
          const moreChannels = await getMoreChannels();
          sendResponse({ success: true, data: moreChannels });
          break;
        }
        case 'UNSUBSCRIBE': {
          const result = await unsubscribeFromChannel(message.channelId);
          sendResponse(result);
          break;
        }
        case 'SUBSCRIBE': {
          const result = await subscribeToChannel(message.channelId);
          sendResponse(result);
          break;
        }
        case 'GET_CHANNEL_SUGGESTIONS': {
          const suggestions = await getChannelSuggestions(message.channelId);
          sendResponse({ success: true, data: suggestions });
          break;
        }
        case 'GET_CHANNEL_VIDEOS': {
          const channelVideos = await getChannelVideos(message.channelId);
          sendResponse({ success: true, data: channelVideos });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.warn('[NuTube] Content script error:', error);
      sendResponse({ success: false, error: String(error) });
    }
  })();

  return true; // Keep the message channel open for async response
});

console.log('NuTube content script loaded');
