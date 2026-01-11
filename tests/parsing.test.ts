// Unit tests for YouTube API parsing functions
// Tests the core parsing logic that extracts video/channel/playlist data from YouTube's InnerTube API

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockPlaylistVideoRenderer,
  mockPlaylistVideoRendererMinimal,
  mockVideoRenderer,
  mockRichItemRenderer,
  mockLockupViewModel,
  mockLockupViewModelWithProgress,
  mockGridChannelRenderer,
  mockChannelLockupViewModel,
  mockGridPlaylistRenderer,
  mockPlaylistLockupViewModel,
  mockContinuationItemRenderer,
} from './fixtures/youtube-responses';

// Since the parsing functions are embedded in content.ts, we need to extract them for testing
// These are re-implementations of the core parsing logic for testability

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
  lastUploadText?: string;
  lastUploadTimestamp?: number;
}

interface Playlist {
  id: string;
  title: string;
  videoCount: number;
  thumbnail?: string;
}

// Re-implementation of parseVideoItem for testing
function parseVideoItem(item: any): Video | null {
  if (!item) return null;
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

// Re-implementation of parseSubscriptionVideoItem for testing
function parseSubscriptionVideoItem(item: any): Video | null {
  if (!item) return null;
  const videoRenderer =
    item.videoRenderer ||
    item.content?.videoRenderer ||
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

// Re-implementation of extractDurationAndProgress for testing
function extractDurationAndProgress(lockup: any): { duration: string; progressPercent: number; watched: boolean } {
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

// Re-implementation of parseLockupViewModel for testing
function parseLockupViewModel(lockup: any): Video | null {
  if (!lockup?.contentId) return null;

  const contentType = lockup.contentType;
  if (contentType && !contentType.includes('VIDEO')) return null;

  const videoId = lockup.contentId;
  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const title = metadata?.title?.content || 'Unknown';

  let channel = 'Unknown';
  const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
  for (const row of metadataRows) {
    const parts = row.metadataParts || [];
    for (const part of parts) {
      if (part.text?.content) {
        channel = part.text.content;
        break;
      }
    }
    if (channel !== 'Unknown') break;
  }

  const { duration, progressPercent, watched } = extractDurationAndProgress(lockup);

  return {
    id: videoId,
    title,
    channel,
    channelId: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration,
    publishedAt: '',
    watched,
    progressPercent,
  };
}

// Re-implementation of parseRelativeTime for testing
function parseRelativeTime(text: string): number | undefined {
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

// ============================================================================
// TESTS
// ============================================================================

describe('parseVideoItem', () => {
  it('should parse a complete playlistVideoRenderer', () => {
    const video = parseVideoItem(mockPlaylistVideoRenderer);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('dQw4w9WgXcQ');
    expect(video?.title).toBe('Never Gonna Give You Up');
    expect(video?.channel).toBe('Rick Astley');
    expect(video?.channelId).toBe('UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(video?.duration).toBe('3:33');
    expect(video?.publishedAt).toBe('2 days ago');
    expect(video?.setVideoId).toBe('PLAbCdEf123456');
  });

  it('should handle minimal playlistVideoRenderer with fallbacks', () => {
    const video = parseVideoItem(mockPlaylistVideoRendererMinimal);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('abc123xyz');
    expect(video?.title).toBe('Unknown');
    expect(video?.channel).toBe('Unknown');
    expect(video?.channelId).toBe('');
    expect(video?.thumbnail).toBe('https://i.ytimg.com/vi/abc123xyz/mqdefault.jpg');
  });

  it('should return null for items without a renderer', () => {
    const video = parseVideoItem({});
    expect(video).toBeNull();
  });

  it('should return null for renderer without videoId', () => {
    const video = parseVideoItem({ playlistVideoRenderer: { title: 'No ID' } });
    expect(video).toBeNull();
  });
});

describe('parseSubscriptionVideoItem', () => {
  it('should parse a videoRenderer', () => {
    const video = parseSubscriptionVideoItem(mockVideoRenderer);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('jNQXAC9IVRw');
    expect(video?.title).toBe('Me at the zoo');
    expect(video?.channel).toBe('jawed');
    expect(video?.channelId).toBe('UC4QobU6STFB0P71PMvOGN5A');
    expect(video?.duration).toBe('0:18');
  });

  it('should parse a richItemRenderer', () => {
    const video = parseSubscriptionVideoItem(mockRichItemRenderer.richItemRenderer);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('test123');
    expect(video?.title).toBe('Test Video in Rich Item');
    expect(video?.channel).toBe('Test Channel');
  });

  it('should return null for non-video items', () => {
    const video = parseSubscriptionVideoItem({});
    expect(video).toBeNull();
  });
});

describe('parseLockupViewModel', () => {
  it('should parse a video lockupViewModel', () => {
    const lockup = mockLockupViewModel.lockupViewModel;
    const video = parseLockupViewModel(lockup);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('lockup123');
    expect(video?.title).toBe('Lockup Video Title');
    expect(video?.channel).toBe('Lockup Channel');
    expect(video?.duration).toBe('15:30');
    expect(video?.watched).toBe(false);
    expect(video?.progressPercent).toBe(0);
  });

  it('should parse lockup with watch progress', () => {
    const lockup = mockLockupViewModelWithProgress.lockupViewModel;
    const video = parseLockupViewModel(lockup);

    expect(video).not.toBeNull();
    expect(video?.id).toBe('watched123');
    expect(video?.progressPercent).toBe(75);
    expect(video?.watched).toBe(false); // 75% < 90%
    expect(video?.duration).toBe('20:00');
  });

  it('should skip non-video lockups', () => {
    const lockup = mockChannelLockupViewModel.lockupViewModel;
    const video = parseLockupViewModel(lockup);

    expect(video).toBeNull();
  });

  it('should return null for lockup without contentId', () => {
    const video = parseLockupViewModel({});
    expect(video).toBeNull();
  });
});

describe('extractDurationAndProgress', () => {
  it('should extract duration from standard overlay', () => {
    const lockup = mockLockupViewModel.lockupViewModel;
    const result = extractDurationAndProgress(lockup);

    expect(result.duration).toBe('15:30');
    expect(result.progressPercent).toBe(0);
    expect(result.watched).toBe(false);
  });

  it('should extract progress from bottom overlay', () => {
    const lockup = mockLockupViewModelWithProgress.lockupViewModel;
    const result = extractDurationAndProgress(lockup);

    expect(result.duration).toBe('20:00');
    expect(result.progressPercent).toBe(75);
    expect(result.watched).toBe(false);
  });

  it('should mark 90%+ as watched', () => {
    const lockupWith95Percent = {
      contentImage: {
        thumbnailViewModel: {
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                progressBar: {
                  thumbnailOverlayProgressBarViewModel: {
                    valueRangeText: '95% watched',
                  },
                },
              },
            },
          ],
        },
      },
    };

    const result = extractDurationAndProgress(lockupWith95Percent);

    expect(result.progressPercent).toBe(95);
    expect(result.watched).toBe(true);
  });

  it('should handle empty overlays', () => {
    const result = extractDurationAndProgress({});

    expect(result.duration).toBe('');
    expect(result.progressPercent).toBe(0);
    expect(result.watched).toBe(false);
  });
});

describe('parseRelativeTime', () => {
  it('should parse "X days ago"', () => {
    const timestamp = parseRelativeTime('3 days ago');
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - threeDaysMs)).toBeLessThan(1000);
  });

  it('should parse "X hours ago"', () => {
    const timestamp = parseRelativeTime('5 hours ago');
    const now = Date.now();
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - fiveHoursMs)).toBeLessThan(1000);
  });

  it('should parse "X weeks ago"', () => {
    const timestamp = parseRelativeTime('2 weeks ago');
    const now = Date.now();
    const twoWeeksMs = 2 * 7 * 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - twoWeeksMs)).toBeLessThan(1000);
  });

  it('should parse "streamed X ago"', () => {
    const timestamp = parseRelativeTime('streamed 1 hour ago');
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - oneHourMs)).toBeLessThan(1000);
  });

  it('should parse "Last uploaded X ago"', () => {
    const timestamp = parseRelativeTime('Last uploaded 4 days ago');
    const now = Date.now();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - fourDaysMs)).toBeLessThan(1000);
  });

  it('should return undefined for invalid input', () => {
    expect(parseRelativeTime('')).toBeUndefined();
    expect(parseRelativeTime('invalid text')).toBeUndefined();
    expect(parseRelativeTime('no time info here')).toBeUndefined();
  });

  it('should handle singular time units', () => {
    const timestamp = parseRelativeTime('1 day ago');
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs((now - timestamp!) - oneDayMs)).toBeLessThan(1000);
  });
});

describe('continuation token extraction', () => {
  it('should find continuation token in renderer', () => {
    const item = mockContinuationItemRenderer;
    const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;

    expect(token).toBe('mock-continuation-token-123');
  });
});

describe('edge cases and error handling', () => {
  it('should handle null/undefined inputs gracefully', () => {
    expect(parseVideoItem(null)).toBeNull();
    expect(parseVideoItem(undefined)).toBeNull();
    expect(parseSubscriptionVideoItem(null)).toBeNull();
    expect(parseLockupViewModel(null)).toBeNull();
  });

  it('should handle deeply nested null values', () => {
    const item = {
      playlistVideoRenderer: {
        videoId: 'test',
        title: null,
        shortBylineText: null,
      },
    };

    const video = parseVideoItem(item);
    expect(video?.title).toBe('Unknown');
    expect(video?.channel).toBe('Unknown');
  });
});
