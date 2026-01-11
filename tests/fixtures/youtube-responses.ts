// Test fixtures for YouTube InnerTube API responses
// These represent the structures returned by YouTube's internal API

export const mockPlaylistVideoRenderer = {
  playlistVideoRenderer: {
    videoId: 'dQw4w9WgXcQ',
    title: {
      runs: [{ text: 'Never Gonna Give You Up' }],
    },
    shortBylineText: {
      runs: [
        {
          text: 'Rick Astley',
          navigationEndpoint: {
            browseEndpoint: {
              browseId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
            },
          },
        },
      ],
    },
    thumbnail: {
      thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' }],
    },
    lengthText: {
      simpleText: '3:33',
    },
    publishedTimeText: {
      simpleText: '2 days ago',
    },
    setVideoId: 'PLAbCdEf123456',
  },
};

export const mockPlaylistVideoRendererMinimal = {
  playlistVideoRenderer: {
    videoId: 'abc123xyz',
    // Missing most fields - test fallback behavior
  },
};

export const mockVideoRenderer = {
  videoRenderer: {
    videoId: 'jNQXAC9IVRw',
    title: {
      runs: [{ text: 'Me at the zoo' }],
    },
    ownerText: {
      runs: [
        {
          text: 'jawed',
          navigationEndpoint: {
            browseEndpoint: {
              browseId: 'UC4QobU6STFB0P71PMvOGN5A',
            },
          },
        },
      ],
    },
    thumbnail: {
      thumbnails: [{ url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg' }],
    },
    lengthText: {
      simpleText: '0:18',
    },
    publishedTimeText: {
      simpleText: '18 years ago',
    },
  },
};

export const mockRichItemRenderer = {
  richItemRenderer: {
    content: {
      videoRenderer: {
        videoId: 'test123',
        title: {
          runs: [{ text: 'Test Video in Rich Item' }],
        },
        shortBylineText: {
          runs: [{ text: 'Test Channel' }],
        },
        lengthText: {
          simpleText: '10:00',
        },
      },
    },
  },
};

export const mockLockupViewModel = {
  lockupViewModel: {
    contentId: 'lockup123',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: {
      lockupMetadataViewModel: {
        title: {
          content: 'Lockup Video Title',
        },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {
                metadataParts: [{ text: { content: 'Lockup Channel' } }],
              },
            ],
          },
        },
      },
    },
    contentImage: {
      thumbnailViewModel: {
        overlays: [
          {
            thumbnailOverlayBadgeViewModel: {
              thumbnailBadges: [
                { thumbnailBadgeViewModel: { text: '15:30' } },
              ],
            },
          },
        ],
      },
    },
  },
};

export const mockLockupViewModelWithProgress = {
  lockupViewModel: {
    contentId: 'watched123',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: {
      lockupMetadataViewModel: {
        title: {
          content: 'Partially Watched Video',
        },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {
                metadataParts: [{ text: { content: 'Some Channel' } }],
              },
            ],
          },
        },
      },
    },
    contentImage: {
      thumbnailViewModel: {
        overlays: [
          {
            thumbnailBottomOverlayViewModel: {
              progressBar: {
                thumbnailOverlayProgressBarViewModel: {
                  valueRangeText: '75% watched',
                },
              },
              badges: [
                { thumbnailBadgeViewModel: { text: '20:00' } },
              ],
            },
          },
        ],
      },
    },
  },
};

export const mockGridChannelRenderer = {
  gridChannelRenderer: {
    channelId: 'UCtest123',
    title: {
      simpleText: 'Test Channel',
    },
    thumbnail: {
      thumbnails: [{ url: 'https://yt3.ggpht.com/test' }],
    },
    subscriberCountText: {
      simpleText: '1.5M subscribers',
    },
    videoCountText: {
      simpleText: '500 videos',
    },
  },
};

export const mockChannelLockupViewModel = {
  lockupViewModel: {
    contentId: 'UCchannel456',
    contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL',
    metadata: {
      lockupMetadataViewModel: {
        title: {
          content: 'Lockup Channel Name',
        },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {
                metadataParts: [
                  { text: { content: '2.3M subscribers' } },
                  { text: { content: '3 days ago' } },
                ],
              },
            ],
          },
        },
      },
    },
    contentImage: {
      collectionThumbnailViewModel: {
        primaryThumbnail: {
          thumbnailViewModel: {
            image: {
              sources: [{ url: 'https://yt3.ggpht.com/channel' }],
            },
          },
        },
      },
    },
  },
};

export const mockGridPlaylistRenderer = {
  gridPlaylistRenderer: {
    playlistId: 'PLtest123',
    title: {
      runs: [{ text: 'My Playlist' }],
    },
    videoCount: '25',
    thumbnail: {
      thumbnails: [{ url: 'https://i.ytimg.com/playlist/test.jpg' }],
    },
  },
};

export const mockPlaylistLockupViewModel = {
  lockupViewModel: {
    contentId: 'PLlockup456',
    contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
    metadata: {
      lockupMetadataViewModel: {
        title: {
          content: 'Lockup Playlist',
        },
      },
    },
  },
};

export const mockContinuationItemRenderer = {
  continuationItemRenderer: {
    continuationEndpoint: {
      continuationCommand: {
        token: 'mock-continuation-token-123',
      },
    },
  },
};

export const mockWatchLaterBrowseResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [
                        {
                          playlistVideoListRenderer: {
                            contents: [
                              mockPlaylistVideoRenderer,
                              mockPlaylistVideoRendererMinimal,
                              mockContinuationItemRenderer,
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

export const mockSubscriptionFeedResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              richGridRenderer: {
                contents: [
                  mockRichItemRenderer,
                  { richItemRenderer: { content: mockLockupViewModel } },
                  mockContinuationItemRenderer,
                ],
              },
            },
          },
        },
      ],
    },
  },
};

export const mockContinuationResponse = {
  onResponseReceivedActions: [
    {
      appendContinuationItemsAction: {
        continuationItems: [
          mockPlaylistVideoRenderer,
          mockContinuationItemRenderer,
        ],
      },
    },
  ],
};
