// Unit tests for background service worker functionality
// Tests message routing and tab management logic

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockChrome, mockTabs, mockRuntime } from './setup';

// Message types (matching background.ts)
type MessageType =
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
  | { type: 'GET_CHANNEL_SUGGESTIONS'; channelId: string };

// Re-implementation of getYouTubeTab for testing
async function getYouTubeTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });

  if (tabs.length > 0) {
    return tabs[0];
  }

  const newTab = await chrome.tabs.create({
    url: 'https://www.youtube.com',
    active: false,
  });

  // In real implementation, this would wait for tab to load
  return newTab;
}

// Re-implementation of sendToContentScript for testing
async function sendToContentScript(message: MessageType, retryCount = 0): Promise<any> {
  const tab = await getYouTubeTab();

  if (!tab.id) {
    throw new Error('Could not get YouTube tab ID');
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response;
  } catch (error: any) {
    if (retryCount >= 2) {
      throw new Error(`Failed to communicate with YouTube tab after 3 attempts: ${error.message}`);
    }

    // Try injecting the content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch {
      // May already be injected, continue
    }

    // Retry with incremented count
    return sendToContentScript(message, retryCount + 1);
  }
}

// Helper to check if sender is from extension
function isFromExtension(sender: { url?: string }): boolean {
  return sender.url?.startsWith('chrome-extension://') ?? false;
}

describe('getYouTubeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return existing YouTube tab if found', async () => {
    const existingTab: chrome.tabs.Tab = {
      id: 123,
      index: 0,
      windowId: 1,
      url: 'https://www.youtube.com/watch?v=test',
      active: true,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    mockTabs.query.mockResolvedValue([existingTab]);

    const tab = await getYouTubeTab();

    expect(mockTabs.query).toHaveBeenCalledWith({
      url: ['https://www.youtube.com/*', 'https://youtube.com/*'],
    });
    expect(tab).toBe(existingTab);
    expect(mockTabs.create).not.toHaveBeenCalled();
  });

  it('should create new YouTube tab if none exists', async () => {
    mockTabs.query.mockResolvedValue([]);

    const newTab: chrome.tabs.Tab = {
      id: 456,
      index: 0,
      windowId: 1,
      url: 'https://www.youtube.com',
      active: false,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    mockTabs.create.mockResolvedValue(newTab);

    const tab = await getYouTubeTab();

    expect(mockTabs.create).toHaveBeenCalledWith({
      url: 'https://www.youtube.com',
      active: false,
    });
    expect(tab).toBe(newTab);
  });
});

describe('sendToContentScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send message to content script successfully', async () => {
    const mockTab: chrome.tabs.Tab = {
      id: 123,
      index: 0,
      windowId: 1,
      active: true,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    mockTabs.query.mockResolvedValue([mockTab]);
    mockTabs.sendMessage.mockResolvedValue({ success: true, data: [] });

    const message: MessageType = { type: 'GET_WATCH_LATER' };
    const response = await sendToContentScript(message);

    expect(mockTabs.sendMessage).toHaveBeenCalledWith(123, message);
    expect(response).toEqual({ success: true, data: [] });
  });

  it('should throw error when tab has no ID', async () => {
    const mockTab: chrome.tabs.Tab = {
      // No id property
      index: 0,
      windowId: 1,
      active: true,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    mockTabs.query.mockResolvedValue([mockTab]);

    await expect(sendToContentScript({ type: 'GET_WATCH_LATER' })).rejects.toThrow(
      'Could not get YouTube tab ID'
    );
  });

  it('should retry on failure up to 3 times', async () => {
    const mockTab: chrome.tabs.Tab = {
      id: 123,
      index: 0,
      windowId: 1,
      active: true,
      pinned: false,
      highlighted: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };

    mockTabs.query.mockResolvedValue([mockTab]);
    mockTabs.sendMessage.mockRejectedValue(new Error('Connection failed'));

    await expect(sendToContentScript({ type: 'GET_WATCH_LATER' })).rejects.toThrow(
      'Failed to communicate with YouTube tab after 3 attempts'
    );

    // Should have attempted 3 times (initial + 2 retries)
    expect(mockTabs.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe('isFromExtension', () => {
  it('should return true for chrome-extension:// URLs', () => {
    expect(isFromExtension({ url: 'chrome-extension://abc123/dashboard.html' })).toBe(true);
    expect(isFromExtension({ url: 'chrome-extension://xyz789/popup.html' })).toBe(true);
  });

  it('should return false for non-extension URLs', () => {
    expect(isFromExtension({ url: 'https://www.youtube.com' })).toBe(false);
    expect(isFromExtension({ url: 'http://example.com' })).toBe(false);
    expect(isFromExtension({ url: 'file:///local/file.html' })).toBe(false);
  });

  it('should return false when URL is undefined', () => {
    expect(isFromExtension({})).toBe(false);
    expect(isFromExtension({ url: undefined })).toBe(false);
  });
});

describe('message types', () => {
  it('should have proper structure for all message types', () => {
    const messages: MessageType[] = [
      { type: 'GET_WATCH_LATER' },
      { type: 'GET_SUBSCRIPTIONS' },
      { type: 'GET_MORE_SUBSCRIPTIONS' },
      { type: 'GET_PLAYLISTS' },
      { type: 'REMOVE_FROM_WATCH_LATER', videoId: 'vid123', setVideoId: 'set456' },
      { type: 'ADD_TO_PLAYLIST', videoId: 'vid123', playlistId: 'pl789' },
      { type: 'ADD_TO_WATCH_LATER', videoId: 'vid123' },
      { type: 'MOVE_TO_TOP', setVideoId: 'set456' },
      { type: 'MOVE_TO_TOP', setVideoId: 'set456', firstSetVideoId: 'first123' },
      { type: 'MOVE_TO_BOTTOM', setVideoId: 'set456' },
      { type: 'MOVE_TO_BOTTOM', setVideoId: 'set456', lastSetVideoId: 'last789' },
      { type: 'MOVE_TO_PLAYLIST', videoId: 'vid123', setVideoId: 'set456', playlistId: 'pl789' },
      { type: 'GET_CHANNELS' },
      { type: 'GET_MORE_CHANNELS' },
      { type: 'UNSUBSCRIBE', channelId: 'UC123' },
      { type: 'GET_CHANNEL_SUGGESTIONS', channelId: 'UC123' },
    ];

    // Verify all messages are valid
    for (const msg of messages) {
      expect(msg.type).toBeDefined();
      expect(typeof msg.type).toBe('string');
    }
  });
});

describe('Chrome API mock integration', () => {
  it('should have mocked chrome.tabs API', () => {
    expect(mockChrome.tabs).toBeDefined();
    expect(mockChrome.tabs.query).toBeDefined();
    expect(mockChrome.tabs.create).toBeDefined();
    expect(mockChrome.tabs.sendMessage).toBeDefined();
  });

  it('should have mocked chrome.runtime API', () => {
    expect(mockChrome.runtime).toBeDefined();
    expect(mockChrome.runtime.onMessage).toBeDefined();
    expect(mockChrome.runtime.getURL).toBeDefined();
  });

  it('should generate correct extension URLs', () => {
    const url = mockChrome.runtime.getURL('dashboard.html');
    expect(url).toBe('chrome-extension://mock-id/dashboard.html');
  });
});
