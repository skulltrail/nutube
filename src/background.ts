// Background service worker for NuTube
// Relays messages between dashboard and content script running on YouTube

import { MessageType } from './types';

// Singleton promise to prevent race conditions when multiple messages arrive simultaneously
let youTubeTabPromise: Promise<chrome.tabs.Tab> | null = null;

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
  // Only process messages from our extension pages (dashboard), not from content scripts
  const isFromExtension = sender.url?.startsWith('chrome-extension://');
  if (!isFromExtension) {
    return false;
  }

  // Handle the async operation
  (async () => {
    try {
      const response = await sendToContentScript(message as MessageType);
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
});

console.log('NuTube background service worker loaded');
