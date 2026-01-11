// Shared types for NuTube extension message passing

export type MessageType =
  | { type: 'GET_WATCH_LATER' }
  | { type: 'GET_SUBSCRIPTIONS' }
  | { type: 'GET_MORE_SUBSCRIPTIONS' }
  | { type: 'GET_PLAYLISTS' }
  | { type: 'REMOVE_FROM_WATCH_LATER'; videoId: string; setVideoId: string }
  | { type: 'ADD_TO_PLAYLIST'; videoId: string; playlistId: string }
  | { type: 'ADD_TO_WATCH_LATER'; videoId: string }
  | { type: 'MOVE_TO_TOP'; setVideoId: string; firstSetVideoId?: string }
  | { type: 'MOVE_TO_BOTTOM'; setVideoId: string; lastSetVideoId?: string }
  | { type: 'MOVE_TO_PLAYLIST'; videoId: string; setVideoId: string; playlistId: string }
  | { type: 'GET_CHANNELS' }
  | { type: 'GET_MORE_CHANNELS' }
  | { type: 'UNSUBSCRIBE'; channelId: string }
  | { type: 'SUBSCRIBE'; channelId: string }
  | { type: 'GET_CHANNEL_SUGGESTIONS'; channelId: string }
  | { type: 'GET_CHANNEL_VIDEOS'; channelId: string }
  | { type: 'PING' };
