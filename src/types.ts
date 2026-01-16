/**
 * NuTube Extension Message Protocol
 *
 * Defines the typed messages exchanged between:
 * - Dashboard UI (sender)
 * - Background service worker (relay)
 * - Content script (executor)
 *
 * MESSAGE CATEGORIES:
 *
 * DATA FETCHING:
 * - GET_WATCH_LATER: Fetch all Watch Later videos
 * - GET_SUBSCRIPTIONS: Fetch subscription feed videos
 * - GET_MORE_SUBSCRIPTIONS: Load next page of subscriptions
 * - GET_PLAYLISTS: Fetch user's playlists
 * - GET_CHANNELS: Fetch subscribed channels
 * - GET_MORE_CHANNELS: Load next page of channels
 * - GET_CHANNEL_VIDEOS: Fetch videos from a specific channel
 * - GET_CHANNEL_SUGGESTIONS: Fetch similar channels
 *
 * WATCH LATER OPERATIONS:
 * - REMOVE_FROM_WATCH_LATER: Remove video from Watch Later
 * - ADD_TO_WATCH_LATER: Add video to Watch Later
 * - MOVE_TO_TOP: Move video to top of Watch Later
 * - MOVE_TO_BOTTOM: Move video to bottom of Watch Later
 * - MOVE_TO_PLAYLIST: Move video from Watch Later to another playlist
 *
 * PLAYLIST OPERATIONS:
 * - ADD_TO_PLAYLIST: Add video to a playlist
 *
 * SUBSCRIPTION OPERATIONS:
 * - SUBSCRIBE: Subscribe to a channel
 * - UNSUBSCRIBE: Unsubscribe from a channel
 *
 * UTILITY:
 * - PING: Health check for content script connectivity
 */

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
