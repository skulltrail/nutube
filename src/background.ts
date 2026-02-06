/**
 * NuTube Background Service Worker
 *
 * This service worker acts as a message relay between the dashboard UI and the
 * content script running on YouTube pages.
 *
 * ARCHITECTURE OVERVIEW:
 * ┌─────────────┐     chrome.runtime     ┌──────────────────┐     chrome.tabs     ┌─────────────┐
 * │  Dashboard  │ ──────────────────────►│ Background Worker│ ───────────────────►│Content Script│
 * │ (dashboard) │ ◄────────────────────── │   (background)   │ ◄───────────────────│  (content)   │
 * └─────────────┘     sendResponse        └──────────────────┘    sendResponse     └─────────────┘
 *
 * MESSAGE FLOW:
 * 1. Dashboard sends message via chrome.runtime.sendMessage()
 * 2. Background worker receives message, validates source
 * 3. Background worker finds/creates YouTube tab
 * 4. Background worker relays message via chrome.tabs.sendMessage()
 * 5. Content script executes InnerTube API call
 * 6. Response flows back through the same chain
 *
 * WHY THIS ARCHITECTURE?
 * - Content scripts can only run on matching URL patterns (youtube.com)
 * - Content scripts have access to YouTube's session cookies and can make
 *   authenticated InnerTube API requests
 * - The dashboard runs as an extension page without YouTube context
 * - The background worker bridges these two isolated contexts
 *
 * SINGLETON TAB MANAGEMENT:
 * Uses youTubeTabPromise to prevent race conditions when multiple messages
 * arrive simultaneously - ensures only one YouTube tab is created/reused.
 */

import { MessageType } from './types';

type ControlMessage =
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'OPEN_SIDE_PANEL'; tabId?: number };

// Singleton promise to prevent race conditions when multiple messages arrive simultaneously
let youTubeTabPromise: Promise<chrome.tabs.Tab> | null = null;
const sidePanelApi = (chrome as any).sidePanel;
const SIDE_PANEL_PATH = 'dashboard.html?surface=sidepanel';

async function notifyDashboardFocusTarget(surface: 'sidepanel' | 'dashboard'): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'FOCUS_NUTUBE_UI', surface });
  } catch {
    // No receiver yet is fine; dashboard may not be open.
  }
}

const relayableMessageTypes = new Set<string>([
  'PING',
  'GET_WATCH_LATER',
  'GET_SUBSCRIPTIONS',
  'GET_MORE_SUBSCRIPTIONS',
  'GET_PLAYLISTS',
  'REMOVE_FROM_WATCH_LATER',
  'ADD_TO_PLAYLIST',
  'ADD_TO_WATCH_LATER',
  'MOVE_TO_TOP',
  'MOVE_TO_BOTTOM',
  'MOVE_TO_PLAYLIST',
  'GET_CHANNELS',
  'GET_MORE_CHANNELS',
  'UNSUBSCRIBE',
  'SUBSCRIBE',
  'GET_CHANNEL_SUGGESTIONS',
  'GET_CHANNEL_VIDEOS',
  'GET_PLAYLIST_VIDEOS',
  'REMOVE_FROM_PLAYLIST',
  'CREATE_PLAYLIST',
  'DELETE_PLAYLIST',
  'RENAME_PLAYLIST',
  'MOVE_PLAYLIST_VIDEO',
]);

function isControlMessage(message: unknown): message is ControlMessage {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return type === 'OPEN_DASHBOARD' || type === 'OPEN_SIDE_PANEL';
}

function isRelayableMessage(message: unknown): message is MessageType {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && relayableMessageTypes.has(type);
}

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;

  const allowedPaths = ['dashboard.html', 'popup.html', 'options.html'];
  return allowedPaths.some(path => sender.url!.startsWith(chrome.runtime.getURL(path)));
}

// Find an existing YouTube tab or create one
async function getYouTubeTab(): Promise<chrome.tabs.Tab> {
  // If we're already getting/creating a tab, wait for that instead of creating another
  if (youTubeTabPromise) {
    return youTubeTabPromise;
  }

  youTubeTabPromise = getYouTubeTabImpl();
  try {
    return await youTubeTabPromise;
  } finally {
    youTubeTabPromise = null;
  }
}

async function getYouTubeTabImpl(): Promise<chrome.tabs.Tab> {
  // First, try to find an existing YouTube tab
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });

  if (tabs.length > 0) {
    return tabs[0];
  }

  // No YouTube tab found, create one (in background)
  const newTab = await chrome.tabs.create({
    url: 'https://www.youtube.com',
    active: false,
  });

  // Wait for the tab to finish loading
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout waiting for YouTube tab to load'));
    }, 30000);

    const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (tabId === newTab.id && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Additional delay to ensure content script is loaded
  await new Promise(resolve => setTimeout(resolve, 1000));

  return newTab;
}

// Send message to content script with retry
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
    } catch (injectError: any) {
      // May already be injected, continue
    }

    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, 500));
    return sendToContentScript(message, retryCount + 1);
  }
}

// Handle messages from dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Control commands are allowed from any page in this extension (including content script).
  if (isControlMessage(message)) {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'Untrusted sender.' });
      return false;
    }

    if (message.type === 'OPEN_DASHBOARD') {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      sendResponse({ success: true });
      return false;
    }

    const openSidePanel = async () => {
      try {
        if (!sidePanelApi) {
          sendResponse({ success: false, error: 'Side panel API unavailable in this browser.' });
          return;
        }
        const tabId = message.tabId ?? sender.tab?.id;
        if (!tabId) {
          sendResponse({ success: false, error: 'No tab id for side panel.' });
          return;
        }
        await sidePanelApi.setOptions({
          tabId,
          path: SIDE_PANEL_PATH,
          enabled: true,
        });
        await sidePanelApi.open({ tabId });
        await notifyDashboardFocusTarget('sidepanel');
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error?.message || String(error) });
      }
    };

    openSidePanel();
    return true;
  }

  // Only trusted extension pages can relay data operations to content script.
  if (!isTrustedExtensionPage(sender)) {
    return false;
  }

  if (!isRelayableMessage(message)) {
    sendResponse({ success: false, error: 'Unsupported message type' });
    return false;
  }

  // Handle the async operation
  (async () => {
    try {
      const response = await sendToContentScript(message);
      sendResponse(response);
    } catch (error: any) {
      sendResponse({ success: false, error: error.message || String(error) });
    }
  })();

  // Return true to indicate we will send response asynchronously
  return true;
});

// Open dashboard when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('dashboard.html'),
  });
  notifyDashboardFocusTarget('dashboard');
});

// Keyboard command handlers for native extension control.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-dashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    notifyDashboardFocusTarget('dashboard');
    return;
  }

  if (command === 'toggle-side-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (!sidePanelApi) return;

    try {
      await sidePanelApi.setOptions({
        tabId: tab.id,
        path: SIDE_PANEL_PATH,
        enabled: true,
      });
      await sidePanelApi.open({ tabId: tab.id });
      await notifyDashboardFocusTarget('sidepanel');
    } catch (error) {
      console.warn('[NuTube] Failed to open side panel:', error);
    }
  }
});

console.log('NuTube background service worker loaded');
