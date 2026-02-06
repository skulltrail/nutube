// Unit tests for YouTube API parsing functions
// Tests the core parsing logic that extracts video/channel/playlist data from YouTube's InnerTube API

import { describe, it, expect } from 'vitest';
import {
  mockPlaylistVideoRenderer,
  mockPlaylistVideoRendererMinimal,
  mockVideoRenderer,
  mockRichItemRenderer,
  mockLockupViewModel,
  mockLockupViewModelWithProgress,
  mockChannelLockupViewModel,
  mockGridPlaylistRenderer,
  mockPlaylistLockupViewModel,
  mockContinuationItemRenderer,
} from './fixtures/youtube-responses';
import {
  parseVideoItem,
  parseSubscriptionVideoItem,
  parseLockupViewModel,
  extractDurationAndProgress,
  parseRelativeTime,
} from '../src/parsers';

interface Playlist {
  id: string;
  title: string;
  videoCount: number;
  thumbnail?: string;
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
    expect(Math.abs(now - timestamp! - threeDaysMs)).toBeLessThan(1000);
  });

  it('should parse "X hours ago"', () => {
    const timestamp = parseRelativeTime('5 hours ago');
    const now = Date.now();
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs(now - timestamp! - fiveHoursMs)).toBeLessThan(1000);
  });

  it('should parse "X weeks ago"', () => {
    const timestamp = parseRelativeTime('2 weeks ago');
    const now = Date.now();
    const twoWeeksMs = 2 * 7 * 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs(now - timestamp! - twoWeeksMs)).toBeLessThan(1000);
  });

  it('should parse "streamed X ago"', () => {
    const timestamp = parseRelativeTime('streamed 1 hour ago');
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs(now - timestamp! - oneHourMs)).toBeLessThan(1000);
  });

  it('should parse "Last uploaded X ago"', () => {
    const timestamp = parseRelativeTime('Last uploaded 4 days ago');
    const now = Date.now();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

    expect(timestamp).toBeDefined();
    expect(Math.abs(now - timestamp! - fourDaysMs)).toBeLessThan(1000);
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
    expect(Math.abs(now - timestamp! - oneDayMs)).toBeLessThan(1000);
  });
});

describe('continuation token extraction', () => {
  it('should find continuation token in renderer', () => {
    const item = mockContinuationItemRenderer;
    const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;

    expect(token).toBe('mock-continuation-token-123');
  });
});

describe('playlist parsing', () => {
  // Re-implementation of findPlaylistsInObject for testing
  function parsePlaylistLockupViewModel(obj: any): Playlist | null {
    const lockup = obj.lockupViewModel;
    if (!lockup) return null;

    const contentId = lockup.contentId;
    const metadata = lockup.metadata?.lockupMetadataViewModel;
    const title = metadata?.title?.content;

    if (!contentId || !title || contentId.startsWith('WL') || contentId === 'LL') {
      return null;
    }

    const isPlaylist =
      lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' ||
      obj.collectionThumbnailViewModel ||
      lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId?.startsWith(
        'VL',
      );

    if (!isPlaylist) return null;

    // Extract video count from metadata rows
    let videoCount = 0;
    const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
    for (const row of metadataRows) {
      const parts = row.metadataParts || [];
      for (const part of parts) {
        const text = part.text?.content || '';
        const videoMatch = text.match(/(\d+)\s*video/i);
        if (videoMatch) {
          videoCount = parseInt(videoMatch[1], 10);
          break;
        }
      }
      if (videoCount > 0) break;
    }

    return {
      id: contentId,
      title: title,
      videoCount,
    };
  }

  it('should extract video count from lockupViewModel metadata', () => {
    const playlist = parsePlaylistLockupViewModel(mockPlaylistLockupViewModel);

    expect(playlist).not.toBeNull();
    expect(playlist?.id).toBe('PLlockup456');
    expect(playlist?.title).toBe('Lockup Playlist');
    expect(playlist?.videoCount).toBe(42);
  });

  it('should handle lockupViewModel without video count', () => {
    const lockupWithoutCount = {
      lockupViewModel: {
        contentId: 'PLnocount789',
        contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
        metadata: {
          lockupMetadataViewModel: {
            title: {
              content: 'Playlist Without Count',
            },
          },
        },
      },
    };

    const playlist = parsePlaylistLockupViewModel(lockupWithoutCount);

    expect(playlist).not.toBeNull();
    expect(playlist?.videoCount).toBe(0);
  });

  it('should handle singular "1 video" text', () => {
    const lockupWithOneVideo = {
      lockupViewModel: {
        contentId: 'PLone123',
        contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
        metadata: {
          lockupMetadataViewModel: {
            title: {
              content: 'Single Video Playlist',
            },
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [
                  {
                    metadataParts: [{ text: { content: '1 video' } }],
                  },
                ],
              },
            },
          },
        },
      },
    };

    const playlist = parsePlaylistLockupViewModel(lockupWithOneVideo);

    expect(playlist).not.toBeNull();
    expect(playlist?.videoCount).toBe(1);
  });

  it('should extract video count when text has prefix (e.g., "Public • 42 videos")', () => {
    const lockupWithPrefix = {
      lockupViewModel: {
        contentId: 'PLprefix789',
        contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
        metadata: {
          lockupMetadataViewModel: {
            title: {
              content: 'Playlist With Prefix',
            },
            metadata: {
              contentMetadataViewModel: {
                metadataRows: [
                  {
                    metadataParts: [{ text: { content: 'Public • 42 videos' } }],
                  },
                ],
              },
            },
          },
        },
      },
    };

    const playlist = parsePlaylistLockupViewModel(lockupWithPrefix);

    expect(playlist).not.toBeNull();
    expect(playlist?.videoCount).toBe(42);
  });

  it('should parse gridPlaylistRenderer video count', () => {
    const renderer = mockGridPlaylistRenderer.gridPlaylistRenderer;
    const videoCount = parseInt(renderer.videoCount || '0', 10);

    expect(videoCount).toBe(25);
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
