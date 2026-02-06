export interface Video {
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

export function parseVideoItem(item: any): Video | null {
  if (!item || typeof item !== 'object') return null;
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

export function parseSubscriptionVideoItem(item: any): Video | null {
  if (!item || typeof item !== 'object') return null;
  const videoRenderer =
    item.videoRenderer ||
    item.content?.videoRenderer ||
    item.gridVideoRenderer ||
    item.compactVideoRenderer;

  if (!videoRenderer) return null;

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

export function extractDurationAndProgress(lockup: any): { duration: string; progressPercent: number; watched: boolean } {
  const result = { duration: '', progressPercent: 0, watched: false };

  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];

  for (const overlay of overlays) {
    const badges1 = overlay.thumbnailOverlayBadgeViewModel?.thumbnailBadges || [];
    for (const badge of badges1) {
      const text = badge.thumbnailBadgeViewModel?.text;
      if (text && /^\d+:\d+/.test(text)) {
        result.duration = text;
      }
    }

    const bottomOverlay = overlay.thumbnailBottomOverlayViewModel;
    if (bottomOverlay) {
      const progressBar = bottomOverlay.progressBar?.thumbnailOverlayProgressBarViewModel;
      if (progressBar?.valueRangeText) {
        const match = progressBar.valueRangeText.match(/(\d+)%/);
        if (match) {
          result.progressPercent = parseInt(match[1], 10);
          result.watched = result.progressPercent >= 90;
        }
      }

      const badges2 = bottomOverlay.badges || [];
      for (const badge of badges2) {
        const text = badge.thumbnailBadgeViewModel?.text;
        if (text && /^\d+:\d+/.test(text)) {
          result.duration = text;
        }
      }
    }

    if (overlay.thumbnailOverlayResumePlaybackRenderer) {
      result.watched = true;
      result.progressPercent = 100;
    }
  }

  return result;
}

export function parseLockupViewModel(lockup: any): Video | null {
  if (!lockup?.contentId) return null;

  const contentType = lockup.contentType;
  if (contentType && !contentType.includes('VIDEO')) return null;

  const videoId = lockup.contentId;
  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const title = metadata?.title?.content || 'Unknown';

  let channel = 'Unknown';
  let channelId = '';
  let publishedAt = '';
  const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
  for (const row of metadataRows) {
    const parts = row.metadataParts || [];
    for (const part of parts) {
      const text = part.text?.content || '';
      const browseEndpoint = part.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint;
      if (browseEndpoint?.browseId?.startsWith('UC')) {
        channel = text;
        channelId = browseEndpoint.browseId;
      } else if (channel === 'Unknown' && text) {
        channel = text;
      }
      if (text.toLowerCase().includes('ago')) {
        publishedAt = text;
      }
    }
  }

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

export function parseRelativeTime(text: string): number | undefined {
  if (!text) return undefined;

  const now = Date.now();
  const lowerText = text.toLowerCase();

  const match = lowerText.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (!match) {
    const altMatch = lowerText.match(/(?:streamed|uploaded)\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
    if (!altMatch) return undefined;
    const [, num, unit] = altMatch;
    return computeTimestamp(now, parseInt(num, 10), unit);
  }

  const [, num, unit] = match;
  return computeTimestamp(now, parseInt(num, 10), unit);
}

export function computeTimestamp(now: number, num: number, unit: string): number {
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
