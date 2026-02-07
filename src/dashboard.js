/**
 * NuTube Dashboard UI
 *
 * A vim-style keyboard-driven interface for managing YouTube Watch Later,
 * Subscriptions, and Channels.
 *
 * KEYBOARD PHILOSOPHY:
 * - j/k for navigation (vim-style)
 * - v for Visual Line mode (range selection with j/k)
 * - Ctrl+v for Visual Block mode (toggle selection with Space)
 * - Escape to clear selection/search
 * - Single-key actions: d=delete, m=move, y=yank
 * - gg/G for jump to top/bottom
 * - / for search
 *
 * STATE MANAGEMENT:
 * - videos[]: Current tab's video list (points to watchLaterVideos or subscriptionVideos)
 * - filteredVideos[]: Search-filtered subset of videos
 * - selectedIndices: Set of selected video indices (supports multi-select)
 * - focusedIndex: Currently focused item (cursor position)
 * - undoStack[]: History for undo operations (per-video and per-channel)
 *
 * COMMUNICATION:
 * Uses chrome.runtime.sendMessage() to communicate with the background worker,
 * which relays messages to the content script running on YouTube.
 * See types.ts for the message protocol.
 *
 * RENDERING:
 * DOM is updated via innerHTML with template strings. The render functions
 * (renderVideos, renderChannels, renderPlaylists) rebuild the entire list.
 * The .focused and .selected classes indicate state.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum items in the undo stack for video operations */
const MAX_UNDO = 50;

/** Maximum items in the undo stack for channel operations */
const MAX_CHANNEL_UNDO = 50;

/** Debounce delay for infinite scroll loading (ms) */
const LOAD_DEBOUNCE_MS = 500;

/** Timeout for pending G key press for gg command (ms) */
const PENDING_G_TIMEOUT_MS = 500;

/** Duration to show toast notifications (ms) */
const TOAST_DURATION_MS = 3000;

/** Time-to-live for stale watched overrides without matching video (ms) */
const STALE_OVERRIDE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Duration to show undo toast for channel unsubscribe (ms) */
const UNDO_TOAST_DURATION_MS = 5000;

/** Timeout for inline unsubscribe confirmation (ms) */
const UNSUBSCRIBE_CONFIRM_TIMEOUT_MS = 2000;

/** Distance from bottom to trigger infinite scroll load (px) */
const INFINITE_SCROLL_THRESHOLD_PX = 500;

/** Debounce delay for scroll event handler (ms) */
const SCROLL_DEBOUNCE_MS = 100;

/** Approximate height of a video item for page size calculation (px) */
const VIDEO_ITEM_HEIGHT_PX = 80;

/** Enable debug logging (set to false in production) */
const DEBUG = false;

/**
 * Log a debug message (only when DEBUG is enabled)
 * @param {...any} args - Arguments to log
 */
function debugLog(...args) {
  if (DEBUG) {
    console.log('[NuTube]', ...args);
  }
}

/**
 * Log a warning (always logged, for recoverable issues)
 * @param {...any} args - Arguments to log
 */
function warnLog(...args) {
  console.warn('[NuTube]', ...args);
}

/**
 * Log an error (always logged, for failures)
 * @param {...any} args - Arguments to log
 */
function errorLog(...args) {
  console.error('[NuTube]', ...args);
}

// =============================================================================
// STATE
// =============================================================================

let videos = [];
let filteredVideos = [];
let playlists = [];
let selectedIndices = new Set();
let focusedIndex = 0;
let visualModeStart = null;
let visualBlockMode = false; // true = block mode (V), false = line mode (v)
let searchQuery = '';
let modalFocusedIndex = 0;
let currentModalItems = [];
let isModalOpen = false;
let isHelpOpen = false;
let pendingG = false;
let hiddenVideoIds = new Set();

// Lookup Maps for O(1) access by ID
/** @type {Map<string, object>} */
let channelMap = new Map();
/** @type {Map<string, object>} */
let playlistMap = new Map();

// Tab state
let currentTab = 'watchlater'; // 'watchlater', 'subscriptions', 'channels', or 'playlists'
let watchLaterVideos = [];
let subscriptionVideos = [];
let channels = [];
let filteredChannels = [];
let isLoadingMore = false; // For infinite scroll
let subscriptionsContinuationExhausted = false;
let lastLoadTime = 0;

// Channels state
let channelSuggestions = [];
let suggestionsFocusedIndex = 0;
let isSuggestionsOpen = false;
let isConfirmOpen = false;
let confirmCallback = null;
let confirmResolver = null;

// Channel preview state
let channelVideoFocusIndex = 0;
let currentChannelVideos = [];

// Inline unsubscribe confirmation state
let pendingUnsubscribe = null; // { channelId, index, timeoutId }

// Keyboard navigation mode state
let isKeyboardNavActive = false;

// Channel undo stack (separate from videos)
const channelUndoStack = [];

// Quick move assignments: { 1: "playlistId", 2: "playlistId", ... }
let quickMoveAssignments = {};

// Hide Watch Later items in subscriptions (on by default)
let hideWatchLaterInSubs = true;

// Watched status overrides (user-set, persisted)
let watchedOverrides = {};

// Global hide-watched toggle (persisted)
let hideWatched = false;

const DEFAULT_SETTINGS = {
  defaultTab: 'watchlater',
  operationConcurrency: 4,
  operationRetries: 2,
  fuzzyThreshold: 0.45,
  keymap: {
    delete: 'x',
    move: 'm',
    refresh: 'r',
  },
};
let nutubeSettings = { ...DEFAULT_SETTINGS };
let smartSortEnabled = false;
let videoAnnotations = {};

// Playlist browser state (two-level drill-down)
let playlistBrowserLevel = 'list'; // 'list' (Level 1) or 'videos' (Level 2)
let activePlaylistId = null;
let playlistVideos = [];
let filteredPlaylists = [];
let playlistSortMode = 'default'; // 'default', 'alpha', 'alpha-reverse', 'count-desc', 'count-asc'
let themePref = 'auto'; // 'auto', 'light', 'dark'

// Undo history
const undoStack = [];

// Surface mode
const isSidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';

// =============================================================================
// LOOKUP HELPERS
// =============================================================================

/**
 * Rebuild the channel lookup map from the current channels array
 */
function rebuildChannelMap() {
  channelMap = new Map(channels.map(c => [c.id, c]));
}

/**
 * Rebuild the playlist lookup map from the current playlists array
 */
function rebuildPlaylistMap() {
  playlistMap = new Map(playlists.map(p => [p.id, p]));
}

/**
 * Get a channel by ID using O(1) Map lookup
 * @param {string} channelId
 * @returns {object|undefined}
 */
function getChannelById(channelId) {
  return channelMap.get(channelId);
}

/**
 * Get a playlist by ID using O(1) Map lookup
 * @param {string} playlistId
 * @returns {object|undefined}
 */
function getPlaylistById(playlistId) {
  return playlistMap.get(playlistId);
}


// =============================================================================
// KEYBOARD NAVIGATION MODE
// =============================================================================

/**
 * Enable keyboard navigation mode - hides cursor and disables hover effects
 * Called when user navigates via keyboard
 */
function enableKeyboardNavMode() {
  if (isKeyboardNavActive) return;
  isKeyboardNavActive = true;
  document.body.classList.add('keyboard-nav-active');
}

/**
 * Disable keyboard navigation mode - restores cursor and hover effects
 * Called when user moves the mouse
 */
function disableKeyboardNavMode() {
  if (!isKeyboardNavActive) return;
  isKeyboardNavActive = false;
  document.body.classList.remove('keyboard-nav-active');
}

// Listen for mouse movement to exit keyboard nav mode
document.addEventListener('mousemove', disableKeyboardNavMode);

// DOM elements
const videoList = document.getElementById('video-list');
const playlistList = document.getElementById('playlist-list');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const videoCountEl = document.getElementById('video-count');
const videoCountLabelEl = document.getElementById('video-count-label');
const selectedCountEl = document.getElementById('selected-count');
const statusMessage = document.getElementById('status-message');
const modeIndicatorEl = document.getElementById('mode-indicator');
const searchInput = document.getElementById('search-input');
const searchContainer = document.querySelector('.search-container');
const modalOverlay = document.getElementById('modal-overlay');
const modalPlaylists = document.getElementById('modal-playlists');
const toastContainer = document.getElementById('toast-container');
const contextMenuEl = document.getElementById('context-menu');
const contextMenuItemsEl = document.getElementById('context-menu-items');
const helpModal = document.getElementById('help-modal');
const tabStrip = document.getElementById('tab-strip');
const tabShiftBefore = document.getElementById('tab-shift-before');
const tabShiftAfter = document.getElementById('tab-shift-after');
const tabWatchLater = document.getElementById('tab-watchlater');
const tabSubscriptions = document.getElementById('tab-subscriptions');
const tabChannels = document.getElementById('tab-channels');
const watchLaterCountEl = document.getElementById('watchlater-count');
const subscriptionsCountEl = document.getElementById('subscriptions-count');
const channelsCountEl = document.getElementById('channels-count');
const suggestionsModal = document.getElementById('suggestions-modal');
const suggestionsList = document.getElementById('suggestions-list');
const confirmModal = document.getElementById('confirm-modal');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmOk = document.getElementById('confirm-ok');
const shortcutsList = document.getElementById('shortcuts-list');
const subscriptionsLoadingEl = document.getElementById('subscriptions-loading');
const loadMoreIndicatorEl = document.getElementById('load-more-indicator');
const hideWatchedIndicatorEl = document.getElementById('hide-watched-indicator');
const tabPlaylists = document.getElementById('tab-playlists');
const playlistsCountEl = document.getElementById('playlists-count');
const breadcrumbEl = document.getElementById('breadcrumb');
const breadcrumbNameEl = document.getElementById('breadcrumb-name');

let contextMenuActions = [];

// Loading indicator helpers
function showSubscriptionsLoading() {
  subscriptionsLoadingEl?.classList.add('active');
  subscriptionsCountEl?.classList.add('loading');
}

function hideSubscriptionsLoading() {
  subscriptionsLoadingEl?.classList.remove('active');
  subscriptionsCountEl?.classList.remove('loading');
}

function setLoadMoreState(state) {
  if (!loadMoreIndicatorEl) return;
  loadMoreIndicatorEl.className = 'load-more-indicator';
  loadMoreIndicatorEl.textContent = '';

  switch (state) {
    case 'loading':
      loadMoreIndicatorEl.classList.add('loading');
      loadMoreIndicatorEl.textContent = 'Loading more...';
      break;
    case 'error':
      loadMoreIndicatorEl.classList.add('error');
      loadMoreIndicatorEl.textContent = 'Failed to load more. Scroll to retry.';
      break;
    case 'exhausted':
      loadMoreIndicatorEl.classList.add('exhausted');
      loadMoreIndicatorEl.textContent = 'No more videos';
      break;
    default:
      // hidden
      break;
  }
}

function setSingleFocusedSelection(index) {
  focusedIndex = index;
  selectedIndices.clear();
  visualModeStart = null;
  visualBlockMode = false;
  updateMode();
}

function getFocusedVideoUrl(video) {
  if (!video) return '';
  return currentTab === 'watchlater'
    ? getWatchLaterVideoUrl(video)
    : `https://www.youtube.com/watch?v=${video.id}`;
}

function getFocusedChannelUrl(channel) {
  if (!channel) return '';
  return `https://www.youtube.com/channel/${channel.id}`;
}

function forceDashboardFocus() {
  if (document.activeElement === searchInput) return;
  try {
    window.focus();
  } catch (_) {
    // Some browsers block programmatic focus shifts.
  }
  document.body.focus({ preventScroll: true });
}

function requestDashboardFocus() {
  forceDashboardFocus();
  // Side panel focus can land asynchronously; retry briefly.
  setTimeout(forceDashboardFocus, 30);
  setTimeout(forceDashboardFocus, 120);
}

function hideContextMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.classList.remove('visible');
  contextMenuActions = [];
}

function showContextMenu(clientX, clientY, items) {
  if (!contextMenuEl || !contextMenuItemsEl || !items || items.length === 0) return;
  contextMenuActions = items;
  contextMenuItemsEl.innerHTML = items.map((item, index) => `
    <button class="context-menu-item ${item.danger ? 'danger' : ''}" data-action-index="${index}" ${item.disabled ? 'disabled' : ''}>
      ${escapeHtml(item.label)}
    </button>
  `).join('');

  contextMenuEl.classList.add('visible');
  contextMenuEl.style.left = '0px';
  contextMenuEl.style.top = '0px';

  const margin = 8;
  const menuRect = contextMenuEl.getBoundingClientRect();
  const maxLeft = window.innerWidth - menuRect.width - margin;
  const maxTop = window.innerHeight - menuRect.height - margin;
  const left = Math.max(margin, Math.min(clientX, maxLeft));
  const top = Math.max(margin, Math.min(clientY, maxTop));
  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top = `${top}px`;

  const firstButton = contextMenuItemsEl.querySelector('.context-menu-item:not(:disabled)');
  if (firstButton) {
    firstButton.focus();
  }
}

function runContextMenuAction(actionIndex) {
  const actionItem = contextMenuActions[actionIndex];
  hideContextMenu();
  if (!actionItem || typeof actionItem.action !== 'function') return;
  try {
    const maybePromise = actionItem.action();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(error => errorLog('Context menu action failed:', error));
    }
  } catch (error) {
    errorLog('Context menu action failed:', error);
  }
}

// Render keyboard shortcuts based on current tab
// Safe: all content is hardcoded static strings, no user input
function renderShortcuts() {
  // Define shortcut categories per tab
  const categories = {
    watchlater: [
      {
        title: 'Actions',
        shortcuts: [
          { keys: ['x', 'd'], desc: 'Delete' },
          { keys: ['m'], desc: 'Move to playlist' },
          { keys: ['1-9'], desc: 'Quick move' },
          { keys: ['t', 'b'], desc: 'Move top/bottom' },
          { keys: ['w'], desc: 'Toggle watched' },
          { keys: ['H'], desc: 'Hide watched' },
          { keys: ['W'], desc: 'Purge watched' },
          { keys: ['u'], desc: 'Undo' },
        ]
      },
      {
        title: 'Selection',
        shortcuts: [
          { keys: ['v'], desc: 'Visual Line (range)' },
          { keys: ['⌃v'], desc: 'Visual Block (toggle)' },
          { keys: ['Space'], desc: 'Open / select (⌃v)' },
          { keys: ['⌃a'], desc: 'Select all' },
        ]
      },
      {
        title: 'Navigate',
        shortcuts: [
          { keys: ['j', 'k'], desc: 'Up/down' },
          { keys: ['gg', 'G'], desc: 'Top/bottom' },
          { keys: ['⌃d', '⌃u'], desc: 'Page down/up' },
          { keys: ['/'], desc: 'Search' },
        ]
      },
      {
        title: 'Other',
        shortcuts: [
          { keys: ['o', '↵'], desc: 'Open' },
          { keys: ['y'], desc: 'Copy URL' },
          { keys: ['e'], desc: 'Edit note/tags' },
          { keys: ['I'], desc: 'Smart sort' },
          { keys: ['B', 'L'], desc: 'Backup exp/import' },
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
          { keys: ['T'], desc: 'Cycle theme' },
          { keys: ['?'], desc: 'Help' },
        ]
      },
    ],
    subscriptions: [
      {
        title: 'Actions',
        shortcuts: [
          { keys: ['w'], desc: 'Toggle watched' },
          { keys: ['H'], desc: 'Hide watched' },
          { keys: ['h'], desc: 'Hide video' },
          { keys: ['f'], desc: 'Toggle WL filter' },
          { keys: ['m'], desc: 'Add to playlist' },
          { keys: ['1-9'], desc: 'Quick add' },
        ]
      },
      {
        title: 'Selection',
        shortcuts: [
          { keys: ['v'], desc: 'Visual Line (range)' },
          { keys: ['⌃v'], desc: 'Visual Block (toggle)' },
          { keys: ['Space'], desc: 'Toggle WL / select (⌃v)' },
          { keys: ['⌃a'], desc: 'Select all' },
        ]
      },
      {
        title: 'Navigate',
        shortcuts: [
          { keys: ['j', 'k'], desc: 'Up/down' },
          { keys: ['gg', 'G'], desc: 'Top/bottom' },
          { keys: ['⌃d', '⌃u'], desc: 'Page down/up' },
          { keys: ['/'], desc: 'Search' },
        ]
      },
      {
        title: 'Other',
        shortcuts: [
          { keys: ['o', '↵'], desc: 'Open' },
          { keys: ['y'], desc: 'Copy URL' },
          { keys: ['e'], desc: 'Edit note/tags' },
          { keys: ['I'], desc: 'Smart sort' },
          { keys: ['B', 'L'], desc: 'Backup exp/import' },
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
          { keys: ['T'], desc: 'Cycle theme' },
          { keys: ['?'], desc: 'Help' },
        ]
      },
    ],
    channels: [
      {
        title: 'Actions',
        shortcuts: [
          { keys: ['Space', 'p'], desc: 'Preview' },
          { keys: ['x', 'd'], desc: 'Unsubscribe' },
          { keys: ['u'], desc: 'Undo' },
        ]
      },
      {
        title: 'Navigate',
        shortcuts: [
          { keys: ['j', 'k'], desc: 'Up/down' },
          { keys: ['gg', 'G'], desc: 'Top/bottom' },
          { keys: ['⌃d', '⌃u'], desc: 'Page down/up' },
          { keys: ['/'], desc: 'Search' },
        ]
      },
      {
        title: 'Preview Modal',
        shortcuts: [
          { keys: ['h', 'l'], desc: 'Scroll videos' },
          { keys: ['0', '$'], desc: 'First/last' },
          { keys: ['↵', 'Space'], desc: 'Watch video' },
          { keys: ['q', 'Esc'], desc: 'Close' },
        ]
      },
      {
        title: 'Other',
        shortcuts: [
          { keys: ['o', '↵'], desc: 'Open channel' },
          { keys: ['y'], desc: 'Copy URL' },
          { keys: ['B', 'L'], desc: 'Backup exp/import' },
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
          { keys: ['T'], desc: 'Cycle theme' },
          { keys: ['?'], desc: 'Help' },
        ]
      },
    ],
    playlists: [
      {
        title: 'Playlist List',
        shortcuts: [
          { keys: ['↵'], desc: 'Open playlist' },
          { keys: ['n'], desc: 'New playlist' },
          { keys: ['x', 'd'], desc: 'Delete playlist' },
        ]
      },
      {
        title: 'Inside Playlist',
        shortcuts: [
          { keys: ['x', 'd'], desc: 'Remove from playlist' },
          { keys: ['w'], desc: 'Toggle watched' },
          { keys: ['H'], desc: 'Hide watched' },
          { keys: ['Esc'], desc: 'Back to list' },
        ]
      },
      {
        title: 'Navigate',
        shortcuts: [
          { keys: ['j', 'k'], desc: 'Up/down' },
          { keys: ['gg', 'G'], desc: 'Top/bottom' },
          { keys: ['⌃d', '⌃u'], desc: 'Page down/up' },
          { keys: ['/'], desc: 'Search' },
        ]
      },
      {
        title: 'Other',
        shortcuts: [
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['e'], desc: 'Edit note/tags' },
          { keys: ['I'], desc: 'Smart sort' },
          { keys: ['B', 'L'], desc: 'Backup exp/import' },
          { keys: ['Tab'], desc: 'Switch tab' },
          { keys: ['T'], desc: 'Cycle theme' },
          { keys: ['?'], desc: 'Help' },
        ]
      },
    ],
  };

  const tabCategories = categories[currentTab] || categories.watchlater;

  // Render categorized shortcuts (safe: all content is static)
  shortcutsList.innerHTML = tabCategories.map(cat => `
    <div class="shortcut-category">
      <div class="shortcut-category-title">${cat.title}</div>
      ${cat.shortcuts.map(s => `
        <div class="shortcut">
          ${s.keys.map(k => `<span class="key">${k}</span>`).join('')}
          <span class="shortcut-desc">${s.desc}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

// Message passing to background
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'FOCUS_NUTUBE_UI') return;
  const targetSurface = message.surface;
  if (targetSurface === 'sidepanel' && isSidePanelSurface) {
    requestDashboardFocus();
    return;
  }
  if (targetSurface === 'dashboard' && !isSidePanelSurface) {
    requestDashboardFocus();
  }
});

// Quick move storage
async function loadQuickMoveAssignments() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['quickMoveAssignments'], (result) => {
      quickMoveAssignments = result.quickMoveAssignments || {};
      resolve();
    });
  });
}

async function saveQuickMoveAssignments() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ quickMoveAssignments }, resolve);
  });
}

async function loadHiddenVideos() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['hiddenVideoIds'], (result) => {
      if (result.hiddenVideoIds) {
        hiddenVideoIds = new Set(result.hiddenVideoIds);
      }
      resolve();
    });
  });
}

async function saveHiddenVideos() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ hiddenVideoIds: Array.from(hiddenVideoIds) }, resolve);
  });
}

// Hide Watch Later filter storage
async function loadHideWatchLaterPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['hideWatchLaterInSubs'], (result) => {
      // Default to true if not set
      hideWatchLaterInSubs = result.hideWatchLaterInSubs !== false;
      resolve();
    });
  });
}

async function saveHideWatchLaterPref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ hideWatchLaterInSubs }, resolve);
  });
}

// Watched overrides storage
async function loadWatchedOverrides() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['watchedOverrides'], (result) => {
      watchedOverrides = result.watchedOverrides || {};
      resolve();
    });
  });
}

async function saveWatchedOverrides() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ watchedOverrides }, resolve);
  });
}

// Hide watched toggle storage
async function loadHideWatchedPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['hideWatched'], (result) => {
      hideWatched = result.hideWatched === true;
      resolve();
    });
  });
}

async function saveHideWatchedPref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ hideWatched }, resolve);
  });
}

// Playlist sort mode storage
async function loadPlaylistSortPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['playlistSortMode'], (result) => {
      playlistSortMode = result.playlistSortMode || 'default';
      resolve();
    });
  });
}

async function savePlaylistSortPref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ playlistSortMode }, resolve);
  });
}

// Theme preference storage
async function loadThemePref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['themePref'], (result) => {
      themePref = result.themePref || 'auto';
      resolve();
    });
  });
}

async function saveThemePref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ themePref }, resolve);
  });
}

async function loadSmartSortPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['smartSortEnabled'], (result) => {
      smartSortEnabled = result.smartSortEnabled === true;
      resolve();
    });
  });
}

async function saveSmartSortPref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ smartSortEnabled }, resolve);
  });
}

async function loadNuTubeSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['nutubeSettings'], (result) => {
      const loaded = result.nutubeSettings || {};
      nutubeSettings = {
        ...DEFAULT_SETTINGS,
        ...loaded,
        keymap: {
          ...DEFAULT_SETTINGS.keymap,
          ...(loaded.keymap || {}),
        },
      };
      resolve();
    });
  });
}

async function loadLastTabPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lastActiveTab'], (result) => {
      const candidate = result.lastActiveTab || nutubeSettings.defaultTab;
      const valid = ['watchlater', 'subscriptions', 'channels', 'playlists'];
      if (valid.includes(candidate)) {
        currentTab = candidate;
      }
      resolve();
    });
  });
}

async function saveLastTabPref() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ lastActiveTab: currentTab }, resolve);
  });
}

async function loadVideoAnnotations() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['videoAnnotations'], (result) => {
      videoAnnotations = result.videoAnnotations || {};
      resolve();
    });
  });
}

async function saveVideoAnnotations() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ videoAnnotations }, resolve);
  });
}

function applyTheme() {
  if (themePref === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', themePref);
  }
  updateThemeIndicator();
}

function cycleTheme() {
  const cycle = { auto: 'light', light: 'dark', dark: 'auto' };
  themePref = cycle[themePref] || 'auto';
  applyTheme();
  saveThemePref();
  showToast(`Theme: ${themePref}`, 'success');
}

function updateThemeIndicator() {
  const el = document.getElementById('theme-indicator');
  if (el) el.textContent = themePref;
}

function updateHideWatchedIndicator() {
  if (hideWatchedIndicatorEl) {
    hideWatchedIndicatorEl.classList.toggle('active', hideWatched);
  }
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getVideoAnnotation(videoId) {
  return videoAnnotations[videoId] || { note: '', tags: [] };
}

function fuzzyScore(query, text) {
  const q = normalizeText(query);
  const t = normalizeText(text);
  if (!q || !t) return 0;
  if (t.includes(q)) {
    return 0.85 + Math.min(0.14, q.length / Math.max(20, t.length));
  }

  let qi = 0;
  let contiguous = 0;
  let maxContiguous = 0;
  let firstMatch = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (firstMatch === -1) firstMatch = i;
      contiguous += 1;
      maxContiguous = Math.max(maxContiguous, contiguous);
      qi += 1;
    } else {
      contiguous = 0;
    }
  }

  if (qi < q.length) return 0;

  const coverage = q.length / t.length;
  const contiguity = maxContiguous / q.length;
  const positionBoost = firstMatch === -1 ? 0 : 1 - (firstMatch / Math.max(1, t.length));
  return (coverage * 0.35) + (contiguity * 0.35) + (positionBoost * 0.3);
}

function buildSearchableText(video) {
  const annotation = getVideoAnnotation(video.id);
  return [
    video.title,
    video.channel,
    annotation.note,
    ...(annotation.tags || []),
  ].filter(Boolean).join(' ');
}

function fuzzyMatchVideo(query, video) {
  const searchable = buildSearchableText(video);
  const score = fuzzyScore(query, searchable);
  return score >= (nutubeSettings.fuzzyThreshold || DEFAULT_SETTINGS.fuzzyThreshold) ? score : 0;
}

function parseDurationSeconds(duration) {
  if (!duration || typeof duration !== 'string' || !duration.includes(':')) return null;
  const parts = duration.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function scoreVideo(video) {
  // Higher score means "watch now". Bias toward unwatched, recent, and medium-length videos.
  const progress = getWatchedProgress(video);
  const watchedPenalty = progress >= 100 ? -1.8 : 0;
  const halfWatchedBoost = progress > 0 && progress < 100 ? 0.7 : 0;

  const durationSeconds = parseDurationSeconds(video.duration);
  let durationScore = 0;
  if (durationSeconds !== null) {
    // Best around ~12 minutes, taper as videos get much shorter/longer.
    const preferred = 12 * 60;
    durationScore = 1 - Math.min(1, Math.abs(durationSeconds - preferred) / preferred);
  }

  const ts = parseRelativeTime(video.publishedAt);
  let recencyScore = 0;
  if (ts) {
    const ageDays = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
    recencyScore = 1 / (1 + ageDays / 5);
  }

  return (durationScore * 0.35) + (recencyScore * 0.55) + halfWatchedBoost + watchedPenalty;
}

async function runWithConcurrency(items, worker, options = {}) {
  const configuredConcurrency = options.concurrency ?? nutubeSettings.operationConcurrency ?? DEFAULT_SETTINGS.operationConcurrency;
  const configuredRetries = options.retries ?? nutubeSettings.operationRetries ?? DEFAULT_SETTINGS.operationRetries;
  const concurrency = Math.max(1, Math.min(8, configuredConcurrency));
  const retries = Math.max(0, Math.min(5, configuredRetries));
  const results = new Array(items.length);

  async function runOne(index) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        results[index] = await worker(items[index], index);
        return;
      } catch (error) {
        if (attempt === retries) {
          results[index] = { success: false, error: String(error) };
          return;
        }
        const delayMs = 300 * (2 ** attempt) + Math.floor(Math.random() * 120);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await runOne(idx);
    }
  });

  await Promise.all(workers);
  return results;
}

function mappedKey(action, fallback) {
  const value = nutubeSettings?.keymap?.[action];
  if (!value || typeof value !== 'string' || value.length !== 1) {
    return fallback;
  }
  return value;
}

/**
 * Get the effective watched progress for a video (0-100).
 * Local overrides take precedence over YouTube's data.
 */
function getWatchedProgress(video) {
  const override = watchedOverrides[video.id];
  if (override) {
    return override.watched ? 100 : 0;
  }
  return video.progressPercent || 0;
}

/**
 * Check if a video is fully watched (100% or override).
 */
function isFullyWatched(video) {
  return getWatchedProgress(video) >= 100;
}

async function pruneStaleOverrides(loadedVideoIds) {
  const now = Date.now();
  const pruned = Object.fromEntries(
    Object.entries(watchedOverrides).filter(([videoId, entry]) =>
      loadedVideoIds.has(videoId) || (now - entry.timestamp) <= STALE_OVERRIDE_TTL_MS
    )
  );
  const changed = Object.keys(pruned).length !== Object.keys(watchedOverrides).length;
  if (changed) {
    watchedOverrides = pruned;
    await saveWatchedOverrides();
  }
}

/**
 * Toggle the Watch Later filter in subscriptions view
 */
function toggleHideWatchLater() {
  hideWatchLaterInSubs = !hideWatchLaterInSubs;
  saveHideWatchLaterPref();
  renderVideos();
  const state = hideWatchLaterInSubs ? 'Hidden' : 'Shown';
  showToast(`Watch Later items: ${state}`, 'success');
}

/**
 * Toggle the global hide-watched filter
 */
function toggleHideWatched() {
  hideWatched = !hideWatched;
  saveHideWatchedPref();
  updateHideWatchedIndicator();
  renderVideos();
  const state = hideWatched ? 'Hiding' : 'Showing';
  showToast(`${state} watched videos`, 'success');
}

function toggleSmartSort() {
  smartSortEnabled = !smartSortEnabled;
  saveSmartSortPref();
  renderCurrentView();
  showToast(smartSortEnabled ? 'Smart queue ranking enabled' : 'Smart queue ranking disabled', 'success');
}

// Update mode indicator in footer
function updateMode() {
  if (modeIndicatorEl) {
    if (visualModeStart !== null) {
      // Show VISUAL LINE or VISUAL BLOCK with selection count
      const selCount = selectedIndices.size;
      const modeName = visualBlockMode ? 'VISUAL BLOCK' : 'VISUAL LINE';
      modeIndicatorEl.textContent = selCount > 1 ? `${modeName} (${selCount})` : modeName;
      modeIndicatorEl.classList.add('visual');
    } else if (selectedIndices.size > 0) {
      // Show selection count even when not in visual mode (e.g., after Ctrl+Click)
      modeIndicatorEl.textContent = `SELECT (${selectedIndices.size})`;
      modeIndicatorEl.classList.add('visual');
    } else {
      modeIndicatorEl.textContent = 'NORMAL';
      modeIndicatorEl.classList.remove('visual');
    }
  }
}

function assignQuickMove(number, playlistId) {
  // Remove any existing assignment for this number
  // Also remove this playlist from any other number
  for (const key of Object.keys(quickMoveAssignments)) {
    if (quickMoveAssignments[key] === playlistId) {
      delete quickMoveAssignments[key];
    }
  }
  if (playlistId) {
    quickMoveAssignments[number] = playlistId;
  }
  saveQuickMoveAssignments();
}

function getQuickMoveNumber(playlistId) {
  for (const [num, id] of Object.entries(quickMoveAssignments)) {
    if (id === playlistId) return num;
  }
  return null;
}

function getPlaylistByQuickMove(number) {
  const playlistId = quickMoveAssignments[number];
  if (playlistId) {
    return getPlaylistById(playlistId);
  }
  return null;
}

// Toast notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}

// Tab switching
function updateTabStateUI(tab, behavior = 'smooth') {
  tabWatchLater.classList.toggle('active', tab === 'watchlater');
  tabSubscriptions.classList.toggle('active', tab === 'subscriptions');
  tabChannels.classList.toggle('active', tab === 'channels');
  tabPlaylists.classList.toggle('active', tab === 'playlists');

  updateTabRolodexClasses();
  centerActiveTab(behavior);
}

function getTabButtons() {
  return [tabPlaylists, tabWatchLater, tabSubscriptions, tabChannels].filter(Boolean);
}

function updateTabRolodexClasses() {
  const tabs = getTabButtons();
  if (tabs.length === 0) return;

  const activeIndex = tabs.findIndex(tab => tab.classList.contains('active'));
  tabs.forEach((tab, index) => {
    tab.classList.remove('rolodex-active', 'rolodex-before', 'rolodex-after', 'rolodex-far');
    if (index === activeIndex) {
      tab.classList.add('rolodex-active');
      return;
    }

    if (index < activeIndex) {
      tab.classList.add('rolodex-before');
      if (activeIndex - index > 1) {
        tab.classList.add('rolodex-far');
      }
      return;
    }

    tab.classList.add('rolodex-after');
    if (index - activeIndex > 1) {
      tab.classList.add('rolodex-far');
    }
  });
}

function updateTabOverflowIndicators() {
  if (!tabStrip) return;
  const epsilon = 2;
  const hasBefore = tabStrip.scrollLeft > epsilon;
  const hasAfter = (tabStrip.scrollLeft + tabStrip.clientWidth) < (tabStrip.scrollWidth - epsilon);
  tabShiftBefore?.classList.toggle('visible', hasBefore);
  tabShiftAfter?.classList.toggle('visible', hasAfter);
}

function centerActiveTab(behavior = 'auto') {
  if (!tabStrip) return;
  const activeTab = tabStrip.querySelector('.nav-tab.active');
  if (!activeTab) return;
  activeTab.scrollIntoView({ block: 'nearest', inline: 'center', behavior });
  updateTabOverflowIndicators();
}

function switchTab(tab) {
  if (tab === currentTab) return;

  hideContextMenu();
  currentTab = tab;
  saveLastTabPref();
  selectedIndices.clear();
  focusedIndex = 0;
  visualModeStart = null;
  visualBlockMode = false;
  searchQuery = '';
  searchInput.value = '';
  searchContainer?.classList.remove('active');

  // Update tab UI
  updateTabStateUI(tab, 'smooth');
  renderShortcuts();

  // Hide breadcrumb when leaving playlists tab
  if (tab !== 'playlists') {
    breadcrumbEl.style.display = 'none';
    playlistBrowserLevel = 'list';
    activePlaylistId = null;
  }

  // Switch data and render
  if (tab === 'channels') {
    renderChannels();
  } else if (tab === 'playlists') {
    renderPlaylistBrowser();
  } else {
    if (tab === 'watchlater') {
      videos = watchLaterVideos;
    } else {
      videos = subscriptionVideos;
    }
    renderVideos();
  }

  const needsLoad =
    (tab === 'watchlater' && watchLaterVideos.length === 0) ||
    (tab === 'subscriptions' && subscriptionVideos.length === 0) ||
    (tab === 'channels' && channels.length === 0) ||
    (tab === 'playlists' && playlists.length === 0);
  if (needsLoad) {
    loadData();
  }
  setStatus('Ready');
}

// Playlist browser rendering (Level 1)
function renderPlaylistBrowser() {
  // Apply search filter to playlists
  const query = searchQuery.trim();
  if (query) {
    const scored = playlists
      .map(playlist => ({ playlist, score: fuzzyScore(query, playlist.title) }))
      .filter(item => item.score >= (nutubeSettings.fuzzyThreshold || DEFAULT_SETTINGS.fuzzyThreshold))
      .sort((a, b) => b.score - a.score);
    filteredPlaylists = scored.map(item => item.playlist);
  } else {
    filteredPlaylists = [...playlists];
  }

  // Apply sorting
  filteredPlaylists = applySortToPlaylists(filteredPlaylists);

  // Clamp focusedIndex
  if (filteredPlaylists.length === 0) {
    focusedIndex = 0;
  } else {
    focusedIndex = Math.min(focusedIndex, filteredPlaylists.length - 1);
  }

  videoList.innerHTML = filteredPlaylists.map((playlist, index) => {
    const focused = index === focusedIndex ? 'focused' : '';
    const thumbnailHtml = playlist.thumbnail
      ? `<img src="${escapeHtml(playlist.thumbnail)}" alt="">`
      : `<span class="playlist-thumbnail-placeholder">&#9654;</span>`;
    return `<div class="playlist-browser-item ${focused}" data-index="${index}">
      <div class="playlist-thumbnail">${thumbnailHtml}</div>
      <div class="playlist-info">
        <div class="playlist-title">${escapeHtml(playlist.title)}</div>
        <div class="playlist-count">${Number(playlist.videoCount) || 0} videos</div>
      </div>
    </div>`;
  }).join('');

  videoCountEl.textContent = filteredPlaylists.length;
  videoCountLabelEl.textContent = 'Playlists:';
  selectedCountEl.textContent = '0';

  // Scroll focused into view
  const focusedEl = videoList.querySelector('.playlist-browser-item.focused');
  if (focusedEl) {
    focusedEl.scrollIntoView({ block: 'nearest' });
  }
}

async function drillIntoPlaylist(playlist) {
  if (!playlist) return;

  activePlaylistId = playlist.id;
  playlistBrowserLevel = 'videos';

  // Show breadcrumb
  breadcrumbEl.style.display = 'flex';
  breadcrumbNameEl.textContent = playlist.title;

  // Show loading state
  setStatus(`Loading ${playlist.title}...`, 'loading');
  videoList.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading playlist...</span></div>';

  try {
    const result = await sendMessage({
      type: 'GET_PLAYLIST_VIDEOS',
      playlistId: playlist.id,
    });

    if (result.success) {
      playlistVideos = result.data || [];
      videos = playlistVideos;
      focusedIndex = 0;
      selectedIndices.clear();
      searchQuery = '';
      searchInput.value = '';
      renderVideos();
      videoCountLabelEl.textContent = 'Videos:';
      setStatus('Ready');
    } else {
      showToast('Failed to load playlist', 'error');
      setStatus('Error loading playlist', 'error');
      drillOutOfPlaylist();
    }
  } catch (error) {
    errorLog('Failed to load playlist:', error);
    showToast('Failed to load playlist', 'error');
    setStatus('Error', 'error');
    drillOutOfPlaylist();
  }
}

function drillOutOfPlaylist() {
  playlistBrowserLevel = 'list';
  activePlaylistId = null;
  breadcrumbEl.style.display = 'none';
  focusedIndex = 0;
  selectedIndices.clear();
  searchQuery = '';
  searchInput.value = '';
  renderPlaylistBrowser();
}

/**
 * Render the appropriate view based on current tab and playlist level.
 * Used by keyboard navigation handlers to dispatch to the correct render function.
 */
function renderCurrentView() {
  if (currentTab === 'channels') {
    renderChannels();
  } else if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
    renderPlaylistBrowser();
  } else {
    renderVideos();
  }
}

function buildVideoContextMenuItems(video) {
  const items = [
    {
      label: 'Open in YouTube',
      action: () => {
        const url = getFocusedVideoUrl(video);
        if (url) window.open(url, '_blank');
      },
    },
    {
      label: 'Copy URL',
      action: async () => {
        const url = getFocusedVideoUrl(video);
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          showToast('URL copied to clipboard', 'success');
        } catch (_) {
          showToast('Failed to copy URL', 'error');
        }
      },
    },
    {
      label: 'Edit note/tags',
      action: () => editFocusedVideoAnnotation(),
    },
    {
      label: isFullyWatched(video) ? 'Mark as Unwatched' : 'Mark as Watched',
      action: () => toggleWatched(),
    },
  ];

  if (currentTab === 'watchlater') {
    items.push(
      { label: 'Move to Playlist...', action: () => openModal() },
      { label: 'Move to Top', action: () => moveToTop() },
      { label: 'Move to Bottom', action: () => moveToBottom() },
      { label: 'Delete from Watch Later', action: () => deleteVideos(), danger: true },
    );
  } else if (currentTab === 'subscriptions') {
    items.push(
      { label: isInWatchLater(video.id) ? 'Remove from Watch Later' : 'Toggle Watch Later', action: () => toggleWatchLater() },
      { label: 'Add to Playlist...', action: () => openModal() },
      { label: 'Hide Video', action: () => toggleHideVideo(), danger: true },
    );
  } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
    items.push(
      { label: 'Move to Another Playlist...', action: () => openModal() },
      { label: 'Remove from Playlist', action: () => deleteFromPlaylist(), danger: true },
    );
  }

  return items;
}

function buildChannelContextMenuItems(channel) {
  return [
    {
      label: 'Open Channel',
      action: () => {
        const url = getFocusedChannelUrl(channel);
        if (url) window.open(url, '_blank');
      },
    },
    {
      label: 'Copy Channel URL',
      action: async () => {
        const url = getFocusedChannelUrl(channel);
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          showToast('URL copied to clipboard', 'success');
        } catch (_) {
          showToast('Failed to copy URL', 'error');
        }
      },
    },
    {
      label: 'Preview Channel',
      action: () => openChannelPreview(channel),
    },
    {
      label: 'Unsubscribe',
      action: () => confirmUnsubscribe(channel),
      danger: true,
    },
  ];
}

function buildPlaylistContextMenuItems(playlist) {
  return [
    {
      label: 'Open Playlist',
      action: () => drillIntoPlaylist(playlist),
    },
    {
      label: 'Rename Playlist',
      action: () => renameSelectedPlaylist(),
    },
    {
      label: 'Delete Playlist',
      action: () => deleteSelectedPlaylist(),
      danger: true,
    },
  ];
}

/**
 * Get the maximum valid index for the current view.
 */
function getMaxIndex() {
  if (currentTab === 'channels') return filteredChannels.length - 1;
  if (currentTab === 'playlists' && playlistBrowserLevel === 'list') return filteredPlaylists.length - 1;
  return filteredVideos.length - 1;
}

// Get next tab in cycle
function getNextTab() {
  if (currentTab === 'playlists') return 'watchlater';
  if (currentTab === 'watchlater') return 'subscriptions';
  if (currentTab === 'subscriptions') return 'channels';
  return 'playlists';
}

// Get previous tab in cycle (for SHIFT+TAB)
function getPrevTab() {
  if (currentTab === 'playlists') return 'channels';
  if (currentTab === 'watchlater') return 'playlists';
  if (currentTab === 'subscriptions') return 'watchlater';
  return 'subscriptions';
}

// Add to Watch Later (for subscriptions tab)
async function addToWatchLater() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  setStatus(`Adding ${targets.length} video(s) to Watch Later...`, 'loading');

  const results = await runWithConcurrency(targets, async (video) => {
    const result = await sendMessage({
      type: 'ADD_TO_WATCH_LATER',
      videoId: video.id,
    });
    if (result.success && !watchLaterVideos.find(v => v.id === video.id)) {
      watchLaterVideos.unshift(video);
    }
    return result;
  });
  watchLaterCountEl.textContent = watchLaterVideos.length;

  const added = results.filter(r => r?.success).length;
  const failed = results.filter(r => !r?.success).length;

  // Exit visual mode after adding
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  renderVideos();
  if (failed > 0) {
    showToast(`Added ${added}/${targets.length} video(s)`, added > 0 ? 'warning' : 'error');
  } else {
    showToast(`Added ${added} video(s) to Watch Later`, 'success');
  }
  setStatus('Ready');
}

async function addVideoToPlaylist(video, playlistId) {
  try {
    return await sendMessage({
      type: 'ADD_TO_PLAYLIST',
      videoId: video.id,
      playlistId,
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function removeVideoFromPlaylist(video, playlistId) {
  try {
    return await sendMessage({
      type: 'REMOVE_FROM_PLAYLIST',
      videoId: video.id,
      setVideoId: video.setVideoId,
      playlistId,
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function removeVideoFromWatchLater(video) {
  try {
    return await sendMessage({
      type: 'REMOVE_FROM_WATCH_LATER',
      videoId: video.id,
      setVideoId: video.setVideoId,
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Toggle watched status on focused/selected videos
 */
function toggleWatched() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  let markedCount = 0;
  let unmarkedCount = 0;
  const updated = { ...watchedOverrides };

  for (const video of targets) {
    const currentlyWatched = isFullyWatched(video);
    if (currentlyWatched) {
      updated[video.id] = { watched: false, timestamp: Date.now() };
      unmarkedCount++;
    } else {
      updated[video.id] = { watched: true, timestamp: Date.now() };
      markedCount++;
    }
  }

  watchedOverrides = updated;
  saveWatchedOverrides();
  renderVideos();

  if (markedCount > 0 && unmarkedCount > 0) {
    showToast(`${markedCount} marked watched, ${unmarkedCount} unmarked`, 'success');
  } else if (markedCount > 0) {
    showToast(`${markedCount} video(s) marked as watched`, 'success');
  } else {
    showToast(`${unmarkedCount} video(s) unmarked`, 'success');
  }
}

/**
 * Remove a video from Watch Later (used in subscriptions tab)
 * Finds the video in the local Watch Later cache to get setVideoId,
 * then sends remove request to YouTube.
 * @param {object} video - The video object to remove
 * @returns {Promise<boolean>} Whether removal was successful
 */
async function removeFromWatchLaterSub(video) {
  // Find the video in watchLaterVideos to get setVideoId
  const wlVideo = watchLaterVideos.find(v => v.id === video.id);
  if (!wlVideo) return false;

  try {
    const result = await sendMessage({
      type: 'REMOVE_FROM_WATCH_LATER',
      videoId: wlVideo.id,
      setVideoId: wlVideo.setVideoId,
    });
    if (result.success || result.error?.includes('409')) {
      // Remove from local cache
      watchLaterVideos = watchLaterVideos.filter(v => v.id !== video.id);
      watchLaterCountEl.textContent = watchLaterVideos.length;
      return true;
    }
  } catch (e) {
    errorLog('Remove from WL failed:', e);
  }
  return false;
}

/**
 * Toggle Watch Later status for the focused video in subscriptions tab.
 * If video is in WL, removes it. If not, adds it.
 */
async function toggleWatchLater() {
  if (currentTab !== 'subscriptions') return;

  const video = filteredVideos[focusedIndex];
  if (!video) return;

  const inWL = isInWatchLater(video.id);

  if (inWL) {
    setStatus('Removing from Watch Later...', 'loading');
    const success = await removeFromWatchLaterSub(video);
    renderVideos();
    showToast(success ? 'Removed from Watch Later' : 'Failed to remove', success ? 'success' : 'error');
  } else {
    setStatus('Adding to Watch Later...', 'loading');
    try {
      const result = await sendMessage({
        type: 'ADD_TO_WATCH_LATER',
        videoId: video.id,
      });
      if (result.success) {
        if (!watchLaterVideos.find(v => v.id === video.id)) {
          watchLaterVideos.unshift(video);
          watchLaterCountEl.textContent = watchLaterVideos.length;
        }
        renderVideos();
        showToast('Added to Watch Later', 'success');
      } else {
        showToast('Failed to add', 'error');
      }
    } catch (e) {
      errorLog('Add to WL failed:', e);
      showToast('Failed to add', 'error');
    }
  }
  setStatus('Ready');
}

/**
 * Toggle hide status for selected/focused videos in subscriptions tab.
 * Hidden videos are stored locally and filtered from view.
 */
async function toggleHideVideo() {
  if (currentTab !== 'subscriptions') return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  let hiddenCount = 0;
  let unhiddenCount = 0;

  for (const video of targets) {
    if (hiddenVideoIds.has(video.id)) {
      hiddenVideoIds.delete(video.id);
      unhiddenCount++;
    } else {
      hiddenVideoIds.add(video.id);
      hiddenCount++;
    }
  }

  await saveHiddenVideos();

  // Exit visual mode after hiding
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  // Adjust focus to stay within bounds
  focusedIndex = Math.min(focusedIndex, Math.max(0, filteredVideos.length - targets.length - 1));
  renderVideos();

  if (hiddenCount > 0 && unhiddenCount > 0) {
    showToast(`Hidden ${hiddenCount}, unhidden ${unhiddenCount}`, 'success');
  } else if (hiddenCount > 0) {
    showToast(`Hidden ${hiddenCount} video(s)`, 'success');
  } else {
    showToast(`Unhidden ${unhiddenCount} video(s)`, 'success');
  }
}

/**
 * Load more subscription videos for infinite scroll.
 * Uses continuation tokens from YouTube's InnerTube API.
 * Debounced to prevent excessive API calls.
 */
async function loadMoreSubscriptions() {
  // Debounce and prevent concurrent loads
  const now = Date.now();
  if (isLoadingMore || currentTab !== 'subscriptions' || subscriptionsContinuationExhausted) return;
  if (now - lastLoadTime < LOAD_DEBOUNCE_MS) return;

  isLoadingMore = true;
  lastLoadTime = now;
  showSubscriptionsLoading();
  setLoadMoreState('loading');

  try {
    debugLog('loadMoreSubscriptions called, current count:', subscriptionVideos.length);
    const result = await sendMessage({ type: 'GET_MORE_SUBSCRIPTIONS' });
    debugLog('loadMoreSubscriptions result:', result.success, 'videos:', result.data?.length || 0);

    if (result.success && result.data && result.data.length > 0) {
      // Add new videos, avoiding duplicates
      const prevCount = subscriptionVideos.length;
      for (const video of result.data) {
        if (!subscriptionVideos.find(v => v.id === video.id)) {
          subscriptionVideos.push(video);
        }
      }
      const newCount = subscriptionVideos.length - prevCount;
      debugLog('Added', newCount, 'new videos, total:', subscriptionVideos.length);

      videos = subscriptionVideos;
      subscriptionsCountEl.textContent = subscriptionVideos.length;
      renderVideos();

      // Recalculate channel activity with new videos
      recalculateChannelActivity();

      setLoadMoreState('hidden');
    } else if (result.success && (!result.data || result.data.length === 0)) {
      debugLog('No more videos to load (continuation exhausted)');
      subscriptionsContinuationExhausted = true;
      setLoadMoreState('exhausted');
    } else if (!result.success) {
      warnLog('Load more failed:', result.error);
      setLoadMoreState('error');
    }
  } catch (e) {
    warnLog('Load more exception:', e);
    setLoadMoreState('error');
  } finally {
    isLoadingMore = false;
    hideSubscriptionsLoading();
  }
}

// Update status
function setStatus(message, type = '') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
}

// Check if a video is in Watch Later
function isInWatchLater(videoId) {
  return watchLaterVideos.some(v => v.id === videoId);
}

// Render video list
function renderVideos() {
  const query = searchQuery.trim();

  // Base filter: exclude hidden videos
  let baseFilter = v => !hiddenVideoIds.has(v.id);

  // Hide fully-watched videos when toggle is active
  if (hideWatched) {
    const origFilter = baseFilter;
    baseFilter = v => origFilter(v) && !isFullyWatched(v);
  }

  // In subscriptions tab, optionally hide videos already in Watch Later
  if (currentTab === 'subscriptions' && hideWatchLaterInSubs) {
    const origFilter = baseFilter;
    baseFilter = v => origFilter(v) && !isInWatchLater(v.id);
  }

  const baseVideos = videos.filter(baseFilter);

  if (query) {
    const scored = [];
    for (const video of baseVideos) {
      const score = fuzzyMatchVideo(query, video);
      if (score > 0) {
        scored.push({ video, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    filteredVideos = scored.map(item => item.video);
  } else {
    filteredVideos = [...baseVideos];
  }

  if (smartSortEnabled) {
    filteredVideos.sort((a, b) => scoreVideo(b) - scoreVideo(a));
  }

  videoList.innerHTML = filteredVideos.map((video, index) => {
    const inWL = currentTab === 'subscriptions' && isInWatchLater(video.id);
    const progress = getWatchedProgress(video);
    const fullyWatched = progress >= 100;
    const annotation = getVideoAnnotation(video.id);
    const hasAnnotation = annotation.note || (annotation.tags && annotation.tags.length > 0);
    return `
    <div class="video-item ${selectedIndices.has(index) ? 'selected' : ''} ${focusedIndex === index ? 'focused' : ''} ${fullyWatched ? 'fully-watched' : ''}"
         data-index="${index}"
         data-video-id="${video.id}">
      <span class="video-index">${index + 1}</span>
      <div class="thumbnail-wrapper">
        <img class="video-thumbnail" src="${fixUrl(video.thumbnail)}" alt="" loading="lazy">
        ${progress > 0 ? `<div class="video-progress" style="width: ${progress}%"></div>` : ''}
      </div>
      <div class="video-info">
        <div class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
        <div class="video-channel">${escapeHtml(video.channel)}</div>
      </div>
      <div class="video-meta">
        ${inWL ? '<span class="wl-check" title="In Watch Later">&#10003;</span>' : ''}
        ${hasAnnotation ? '<span class="wl-check" title="Annotated">&#128221;</span>' : ''}
        <span class="video-duration">${video.duration || '--:--'}</span>
      </div>
    </div>
  `;
  }).join('');

  videoCountLabelEl.textContent = 'Videos:';
  videoCountEl.textContent = videos.length;
  selectedCountEl.textContent = selectedIndices.size;

  scrollFocusedIntoView();
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fix protocol-relative URLs (//domain.com) for extension context
function fixUrl(url) {
  if (url && url.startsWith('//')) {
    return 'https:' + url;
  }
  return url;
}

// Render playlists (sidebar - only shows assigned quick moves)
function renderPlaylists() {
  // Show playlists that have quick move assignments, sorted by number
  const assignedPlaylists = [];
  for (let i = 1; i <= 9; i++) {
    const playlist = getPlaylistByQuickMove(i);
    if (playlist) {
      assignedPlaylists.push({ num: i, playlist });
    }
  }

  if (assignedPlaylists.length === 0) {
    playlistList.innerHTML = `
      <div class="playlist-item" style="color: var(--text-muted); cursor: default; font-size: 11px;">
        Press m to assign quick moves
      </div>
    `;
    return;
  }

  playlistList.innerHTML = assignedPlaylists.map(({ num, playlist }) => `
    <div class="playlist-item" data-playlist-id="${playlist.id}">
      <span class="playlist-key">${num}</span>
      <span class="playlist-name" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</span>
    </div>
  `).join('');

  if (playlists.length > assignedPlaylists.length) {
    playlistList.innerHTML += `
      <div class="playlist-item" style="color: var(--text-muted); cursor: default; font-size: 11px;">
        +${playlists.length - assignedPlaylists.length} more (press m)
      </div>
    `;
  }

}

// Get sorted playlists for modal display
function getSortedPlaylists() {
  return [...playlists].sort((a, b) => {
    const aNum = getQuickMoveNumber(a.id);
    const bNum = getQuickMoveNumber(b.id);

    // Assigned playlists come first, sorted by number
    if (aNum && bNum) return parseInt(aNum) - parseInt(bNum);
    if (aNum) return -1;
    if (bNum) return 1;

    // Then alphabetically
    return a.title.localeCompare(b.title);
  });
}

// Render modal playlists
function renderModalPlaylists() {
  const sortedPlaylists = getSortedPlaylists();
  // In subscriptions tab, prepend Watch Later as first option
  const watchLaterEntry = { id: 'WL', title: 'Watch Later', videoCount: watchLaterVideos.length };
  const modalItems = currentTab === 'subscriptions'
    ? [watchLaterEntry, ...sortedPlaylists]
    : sortedPlaylists;
  currentModalItems = modalItems;

  modalPlaylists.innerHTML = modalItems.map((playlist, index) => {
    const quickMoveNum = getQuickMoveNumber(playlist.id);
    return `
    <div class="modal-playlist ${modalFocusedIndex === index ? 'focused' : ''}"
         data-index="${index}"
         data-playlist-id="${playlist.id}">
      <span class="playlist-key ${quickMoveNum ? 'assigned' : ''}">${quickMoveNum || ''}</span>
      <span class="playlist-name">${escapeHtml(playlist.title)}</span>
      <span class="playlist-count">${playlist.videoCount} videos</span>
    </div>
  `;
  }).join('');

  // Add hint at the bottom
  modalPlaylists.innerHTML += `
    <div class="modal-hint">
      Press 1-9 to assign quick move to focused playlist
    </div>
  `;

  // Scroll focused item into view
  const focused = modalPlaylists.querySelector('.modal-playlist.focused');
  if (focused) {
    focused.scrollIntoView({ block: 'nearest' });
  }
}

// Scroll focused item into view - center when single selection, nearest otherwise
function scrollFocusedIntoView() {
  const focused = videoList.querySelector('.focused') || videoList.querySelector('.channel-item.focused');
  if (focused) {
    // Use 'center' for single item navigation, 'nearest' for visual mode
    const block = (visualModeStart === null && selectedIndices.size === 0) ? 'center' : 'nearest';
    // Use 'auto' for instant scroll response when holding keys
    focused.scrollIntoView({ block, behavior: 'auto' });
  }
}

// Parse relative time text (e.g., "3 days ago") to timestamp
function parseRelativeTime(text) {
  if (!text) return undefined;
  const lowerText = text.toLowerCase();
  const match = lowerText.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (!match) return undefined;

  const num = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  const msPerUnit = {
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

// Derive channel activity from subscription videos
// Returns a Map of channelId -> { lastUploadText, lastUploadTimestamp }
function deriveChannelActivity(subscriptionVideos) {
  const activity = new Map();

  for (const video of subscriptionVideos) {
    if (!video.channelId) continue;

    const timestamp = parseRelativeTime(video.publishedAt);
    if (!timestamp) continue;

    const existing = activity.get(video.channelId);
    // Keep the most recent upload for each channel
    if (!existing || timestamp > existing.lastUploadTimestamp) {
      activity.set(video.channelId, {
        lastUploadText: video.publishedAt,
        lastUploadTimestamp: timestamp,
      });
    }
  }

  return activity;
}

// Apply derived activity data to channels
function applyChannelActivity(channels, activityMap) {
  for (const channel of channels) {
    const activity = activityMap.get(channel.id);
    if (activity) {
      channel.lastUploadText = activity.lastUploadText;
      channel.lastUploadTimestamp = activity.lastUploadTimestamp;
    }
  }
}

// Recalculate and apply channel activity from current subscription videos
function recalculateChannelActivity() {
  if (subscriptionVideos.length === 0 || channels.length === 0) return;

  const activityMap = deriveChannelActivity(subscriptionVideos);
  applyChannelActivity(channels, activityMap);

  // Re-render channels if we're on that tab
  if (currentTab === 'channels') {
    renderChannels();
  }
}

// Channel Preview Modal Management
// Note: Video preview opens directly on YouTube (no modal needed due to CSP restrictions)

let isChannelPreviewOpen = false;

function openChannelPreview(channel) {
  isChannelPreviewOpen = true;
  showChannelPreview(channel);
}

function closeChannelPreview() {
  if (!isChannelPreviewOpen) return false;
  isChannelPreviewOpen = false;
  document.getElementById('channel-preview-modal').classList.remove('visible');
  currentChannelVideos = [];
  return true;
}

// Build URL for Watch Later video with playlist context
function getWatchLaterVideoUrl(video) {
  const index = watchLaterVideos.findIndex(v => v.id === video.id) + 1;
  return `https://www.youtube.com/watch?v=${video.id}&list=WL&index=${index}`;
}

// Video Preview - opens directly on YouTube since embeds don't work from chrome-extension:// origin
function showVideoPreview(video) {
  window.open(getWatchLaterVideoUrl(video), '_blank');
}

async function editFocusedVideoAnnotation() {
  const video = filteredVideos[focusedIndex];
  if (!video) return;

  const current = getVideoAnnotation(video.id);
  const note = await openInputDialog({
    title: 'Edit Video Note',
    message: video.title,
    defaultValue: current.note || '',
    placeholder: 'Optional note',
    confirmText: 'Next',
  });
  if (note === null) return;

  const tagsRaw = await openInputDialog({
    title: 'Edit Video Tags',
    message: 'Comma-separated tags (for search and smart filtering).',
    defaultValue: (current.tags || []).join(', '),
    placeholder: 'tutorial, longform, music',
    confirmText: 'Save',
  });
  if (tagsRaw === null) return;

  const tags = tagsRaw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);

  videoAnnotations[video.id] = {
    note: note.trim(),
    tags,
    updatedAt: Date.now(),
  };
  await saveVideoAnnotations();
  renderVideos();
  showToast('Annotation saved', 'success');
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    settings: nutubeSettings,
    quickMoveAssignments,
    hiddenVideoIds: Array.from(hiddenVideoIds),
    watchedOverrides,
    hideWatchLaterInSubs,
    hideWatched,
    playlistSortMode,
    themePref,
    lastActiveTab: currentTab,
    videoAnnotations,
  };
  downloadFile(
    `nutube-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
  showToast('Backup exported', 'success');
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const data = JSON.parse(content);
      await chrome.storage.local.set({
        nutubeSettings: data.settings || nutubeSettings,
        quickMoveAssignments: data.quickMoveAssignments || quickMoveAssignments,
        hiddenVideoIds: data.hiddenVideoIds || Array.from(hiddenVideoIds),
        watchedOverrides: data.watchedOverrides || watchedOverrides,
        hideWatchLaterInSubs: data.hideWatchLaterInSubs ?? hideWatchLaterInSubs,
        hideWatched: data.hideWatched ?? hideWatched,
        playlistSortMode: data.playlistSortMode || playlistSortMode,
        themePref: data.themePref || themePref,
        lastActiveTab: data.lastActiveTab || currentTab,
        videoAnnotations: data.videoAnnotations || videoAnnotations,
      });
      showToast('Backup imported. Reloading view...', 'success');
      loadAllData();
    } catch (error) {
      showToast('Invalid backup file', 'error');
    }
  });
  input.click();
}

// Channel Preview - fetches videos from the channel's profile
async function showChannelPreview(channel) {
  const modal = document.getElementById('channel-preview-modal');
  const bannerEl = document.getElementById('channel-preview-banner');
  const avatarEl = document.getElementById('channel-preview-avatar');
  const nameEl = document.getElementById('channel-preview-name');
  const statsEl = document.getElementById('channel-preview-stats');
  const videosEl = document.getElementById('channel-preview-videos');
  const similarEl = document.getElementById('channel-preview-similar');

  // Set channel info (using textContent for security)
  nameEl.textContent = channel.name;
  statsEl.textContent = channel.subscriberCount || '';
  avatarEl.src = fixUrl(channel.thumbnail) || '';

  // Banner - use a gradient if no banner available
  bannerEl.style.backgroundImage = '';

  // Show loading state for videos
  videosEl.textContent = '';
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'channel-no-videos';
  loadingDiv.textContent = 'Loading videos...';
  videosEl.appendChild(loadingDiv);

  // Show loading state for similar channels
  similarEl.textContent = '';
  const similarLoadingDiv = document.createElement('div');
  similarLoadingDiv.className = 'channel-no-videos';
  similarLoadingDiv.textContent = 'Loading similar channels...';
  similarEl.appendChild(similarLoadingDiv);

  modal.classList.add('visible');

  // Fetch videos and similar channels in parallel
  const [videosResponse, similarResponse] = await Promise.all([
    sendMessage({ type: 'GET_CHANNEL_VIDEOS', channelId: channel.id }).catch(e => {
      warnLog('Error fetching channel videos:', e);
      return { success: false, error: String(e) };
    }),
    sendMessage({ type: 'GET_CHANNEL_SUGGESTIONS', channelId: channel.id }).catch(e => {
      warnLog('Error fetching similar channels:', e);
      return { success: false, error: String(e) };
    }),
  ]);

  // Handle videos response
  if (videosResponse.success && videosResponse.data) {
    currentChannelVideos = videosResponse.data;
    channelVideoFocusIndex = 0;

    if (currentChannelVideos.length === 0) {
      videosEl.textContent = '';
      const noVideosDiv = document.createElement('div');
      noVideosDiv.className = 'channel-no-videos';
      noVideosDiv.textContent = 'No videos found';
      videosEl.appendChild(noVideosDiv);
    } else {
      renderChannelVideos();
    }
  } else {
    videosEl.textContent = '';
    const errorDiv = document.createElement('div');
    errorDiv.className = 'channel-no-videos';
    errorDiv.textContent = 'Failed to load videos';
    videosEl.appendChild(errorDiv);
  }

  // Handle similar channels response
  if (similarResponse.success && similarResponse.data && similarResponse.data.length > 0) {
    // Filter out channels we're already subscribed to
    const filteredSimilar = similarResponse.data.filter(s => !getChannelById(s.id));
    renderSimilarChannelsInPreview(filteredSimilar);
  } else {
    similarEl.textContent = '';
    const noSimilarDiv = document.createElement('div');
    noSimilarDiv.className = 'channel-no-videos';
    noSimilarDiv.textContent = 'No similar channels found';
    similarEl.appendChild(noSimilarDiv);
  }
}

// Render similar channels in the channel preview modal
function renderSimilarChannelsInPreview(similarChannels) {
  const similarEl = document.getElementById('channel-preview-similar');
  similarEl.textContent = '';

  if (similarChannels.length === 0) {
    const noSimilarDiv = document.createElement('div');
    noSimilarDiv.className = 'channel-no-videos';
    noSimilarDiv.textContent = 'No similar channels found';
    similarEl.appendChild(noSimilarDiv);
    return;
  }

  similarChannels.forEach(channel => {
    const item = document.createElement('div');
    item.className = 'similar-channel-item';
    item.dataset.channelId = channel.id;

    const thumb = document.createElement('img');
    thumb.className = 'similar-channel-thumb';
    thumb.src = fixUrl(channel.thumbnail) || '';
    thumb.alt = '';
    thumb.loading = 'lazy';
    item.appendChild(thumb);

    const name = document.createElement('div');
    name.className = 'similar-channel-name';
    name.title = channel.name;
    name.textContent = channel.name;
    item.appendChild(name);

    item.addEventListener('click', () => {
      window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
    });

    similarEl.appendChild(item);
  });
}

function renderChannelVideos() {
  const videosEl = document.getElementById('channel-preview-videos');
  videosEl.textContent = '';

  currentChannelVideos.forEach((video, index) => {
    const item = document.createElement('div');
    item.className = 'channel-video-item' + (index === channelVideoFocusIndex ? ' focused' : '');
    item.dataset.index = index;
    item.dataset.videoId = video.id;

    const thumb = document.createElement('img');
    thumb.className = 'channel-video-thumb';
    thumb.src = fixUrl(video.thumbnail);
    thumb.alt = '';
    thumb.loading = 'lazy';
    item.appendChild(thumb);

    const title = document.createElement('div');
    title.className = 'channel-video-title';
    title.title = video.title;
    title.textContent = video.title;
    item.appendChild(title);

    const duration = document.createElement('div');
    duration.className = 'channel-video-duration';
    duration.textContent = (video.duration || '') + (video.publishedAt ? ' · ' + video.publishedAt : '');
    item.appendChild(duration);

    item.addEventListener('click', () => {
      channelVideoFocusIndex = index;
      renderChannelVideos();
      previewChannelVideo();
    });

    videosEl.appendChild(item);
  });

  // Scroll focused video into view
  const focused = videosEl.querySelector('.focused');
  if (focused) {
    focused.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function previewChannelVideo() {
  const video = currentChannelVideos[channelVideoFocusIndex];
  if (!video) return;

  // Open video directly (no modal stack since it opens in new tab)
  showVideoPreview(video);
}

function scrollChannelVideos(direction) {
  const maxIndex = currentChannelVideos.length - 1;
  if (direction === 'left') {
    channelVideoFocusIndex = Math.max(0, channelVideoFocusIndex - 1);
  } else {
    channelVideoFocusIndex = Math.min(maxIndex, channelVideoFocusIndex + 1);
  }
  renderChannelVideos();
}

// Get activity class for channel based on last upload timestamp
function getActivityClass(channel) {
  if (!channel.lastUploadTimestamp) return '';

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const age = now - channel.lastUploadTimestamp;

  if (age < dayMs) return 'recent';        // < 24 hours
  if (age < 7 * dayMs) return 'week';      // < 7 days
  return '';
}

// Format channel stats line with subscriber count and activity info
function formatChannelStats(channel, isConfirming) {
  if (isConfirming) {
    return '(press x/d again to unsubscribe)';
  }

  const parts = [];
  if (channel.subscriberCount) {
    parts.push(channel.subscriberCount);
  }

  // Add last upload info if available
  if (channel.lastUploadText) {
    parts.push(channel.lastUploadText);
  } else if (channel.videoCount) {
    // Fallback to video count if no upload date
    parts.push(channel.videoCount);
  }

  return parts.join(' · ');
}

// Render channels list
// Note: All dynamic content is escaped via escapeHtml() or comes from trusted API sources
function renderChannels() {
  const query = searchQuery.trim();
  if (query) {
    const scored = channels
      .map(channel => ({
        channel,
        score: fuzzyScore(query, `${channel.name} ${channel.subscriberCount || ''} ${channel.lastUploadText || ''}`),
      }))
      .filter(item => item.score >= (nutubeSettings.fuzzyThreshold || DEFAULT_SETTINGS.fuzzyThreshold))
      .sort((a, b) => b.score - a.score);
    filteredChannels = scored.map(item => item.channel);
  } else {
    filteredChannels = [...channels];
  }

  videoList.innerHTML = filteredChannels.map((channel, index) => {
    const isConfirming = pendingUnsubscribe && pendingUnsubscribe.channelId === channel.id;
    const activityClass = getActivityClass(channel);
    const activityDot = activityClass ? `<span class="activity-dot ${activityClass}"></span>` : '';

    return `
    <div class="channel-item ${focusedIndex === index ? 'focused' : ''} ${isConfirming ? 'confirming' : ''}"
         data-index="${index}"
         data-channel-id="${channel.id}">
      <span class="video-index">${index + 1}</span>
      ${channel.thumbnail
        ? `<img class="channel-thumbnail" src="${fixUrl(channel.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}<div class="channel-avatar-fallback">${escapeHtml(channel.name.charAt(0).toUpperCase())}</div>
      <div class="channel-info">
        <div class="channel-name-wrapper">
          ${activityDot}
          <div class="channel-name" title="${escapeHtml(channel.name)}">${escapeHtml(channel.name)}</div>
        </div>
        <div class="channel-stats">${escapeHtml(formatChannelStats(channel, isConfirming))}</div>
      </div>
    </div>
  `;
  }).join('');

  videoCountLabelEl.textContent = 'Channels:';
  videoCountEl.textContent = channels.length;
  selectedCountEl.textContent = '0';

  scrollFocusedIntoView();
}

// Start inline unsubscribe confirmation (first press of x/d)
function startUnsubscribeConfirm(channel, index) {
  // If already confirming this channel, execute the unsubscribe
  if (pendingUnsubscribe && pendingUnsubscribe.channelId === channel.id) {
    executeUnsubscribe(channel);
    return;
  }

  // Cancel any existing pending confirmation
  cancelUnsubscribeConfirm();

  // Set up new pending confirmation with timeout
  const timeoutId = setTimeout(() => {
    cancelUnsubscribeConfirm();
  }, UNSUBSCRIBE_CONFIRM_TIMEOUT_MS);

  pendingUnsubscribe = {
    channelId: channel.id,
    index,
    timeoutId,
    channel, // Store full channel for undo
  };

  renderChannels();
}

// Cancel pending unsubscribe confirmation
function cancelUnsubscribeConfirm() {
  if (pendingUnsubscribe) {
    clearTimeout(pendingUnsubscribe.timeoutId);
    pendingUnsubscribe = null;
    renderChannels();
  }
}

// Execute the unsubscribe after confirmation
async function executeUnsubscribe(channel) {
  cancelUnsubscribeConfirm();

  // Store for undo before removing
  const originalIndex = channels.findIndex(c => c.id === channel.id);
  const channelCopy = { ...channel };

  setStatus(`Unsubscribing from ${channel.name}...`, 'loading');
  try {
    const result = await sendMessage({ type: 'UNSUBSCRIBE', channelId: channel.id });
    if (result.success) {
      // Remove from channels list
      channels = channels.filter(c => c.id !== channel.id);
      channelsCountEl.textContent = channels.length;
      focusedIndex = Math.min(focusedIndex, Math.max(0, channels.length - 1));

      // Add to undo stack
      channelUndoStack.push({
        action: 'unsubscribe',
        channel: channelCopy,
        originalIndex,
        timestamp: Date.now(),
      });
      if (channelUndoStack.length > MAX_CHANNEL_UNDO) {
        channelUndoStack.shift();
      }

      renderChannels();

      // Show undo toast with 5-second duration
      showChannelUndoToast(channelCopy);
    } else {
      showToast('Failed to unsubscribe', 'error');
    }
  } catch (e) {
    errorLog('Unsubscribe failed:', e);
    showToast('Failed to unsubscribe', 'error');
  }
  setStatus('Ready');
}

// Show toast with undo option for channel unsubscribe
function showChannelUndoToast(channel) {
  const toast = document.createElement('div');
  toast.className = 'toast success';
  toast.innerHTML = `Unsubscribed from ${escapeHtml(channel.name)}. Press <span class="key" style="display:inline-block;min-width:18px;height:18px;padding:0 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:2px;font-size:10px;margin:0 2px;">z</span> to undo`;
  toastContainer.appendChild(toast);

  // Remove after undo toast duration
  setTimeout(() => toast.remove(), UNDO_TOAST_DURATION_MS);
}

// Undo last channel unsubscribe
async function undoChannelUnsubscribe() {
  if (channelUndoStack.length === 0) {
    showToast('Nothing to undo', 'info');
    return;
  }

  const lastAction = channelUndoStack.pop();
  if (lastAction.action !== 'unsubscribe') {
    showToast('Cannot undo this action', 'error');
    return;
  }

  setStatus(`Resubscribing to ${lastAction.channel.name}...`, 'loading');
  try {
    const result = await sendMessage({ type: 'SUBSCRIBE', channelId: lastAction.channel.id });
    if (result.success) {
      // Re-insert channel at original position (or end if position no longer valid)
      const insertIndex = Math.min(lastAction.originalIndex, channels.length);
      channels.splice(insertIndex, 0, lastAction.channel);
      channelsCountEl.textContent = channels.length;
      focusedIndex = insertIndex;
      renderChannels();
      showToast(`Resubscribed to ${lastAction.channel.name}`, 'success');
    } else {
      // Put it back on the stack if failed
      channelUndoStack.push(lastAction);
      showToast('Failed to resubscribe', 'error');
    }
  } catch (e) {
    errorLog('Resubscribe failed:', e);
    channelUndoStack.push(lastAction);
    showToast('Failed to resubscribe', 'error');
  }
  setStatus('Ready');
}

// Legacy confirm modal functions (kept for other potential uses)
function confirmUnsubscribe(channel) {
  // Now uses inline confirmation instead
  startUnsubscribeConfirm(channel, focusedIndex);
}

// Close confirm modal
function closeConfirm(confirmed = false) {
  isConfirmOpen = false;
  confirmModal.classList.remove('visible');
  confirmCallback = null;
  if (confirmResolver) {
    confirmResolver(confirmed);
    confirmResolver = null;
  }
}

function openConfirmDialog({ title, message, confirmText = 'Confirm' }) {
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  confirmOk.textContent = confirmText;

  isConfirmOpen = true;
  confirmModal.classList.add('visible');

  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmCallback = () => closeConfirm(true);
  });
}

function openInputDialog({ title, message = '', defaultValue = '', placeholder = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" style="min-width: 380px;">
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p style="color: var(--text-secondary); margin: 10px 0;">${escapeHtml(message)}</p>` : ''}
        <input id="nutube-input-dialog-value" type="text" style="width:100%;margin:10px 0 14px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}">
        <div class="confirm-buttons">
          <button class="btn-cancel" id="nutube-input-dialog-cancel">Cancel</button>
          <button class="btn-confirm" id="nutube-input-dialog-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#nutube-input-dialog-value');
    const cancel = overlay.querySelector('#nutube-input-dialog-cancel');
    const confirm = overlay.querySelector('#nutube-input-dialog-confirm');

    const cleanup = () => overlay.remove();
    const onCancel = () => { cleanup(); resolve(null); };
    const onConfirm = () => { const value = input.value; cleanup(); resolve(value); };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };

    cancel.addEventListener('click', onCancel);
    confirm.addEventListener('click', onConfirm);
    overlay.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

// Render suggestions list
function renderSuggestions() {
  suggestionsList.innerHTML = channelSuggestions.map((channel, index) => `
    <div class="suggestion-item ${suggestionsFocusedIndex === index ? 'focused' : ''}"
         data-index="${index}"
         data-channel-id="${channel.id}">
      <img class="suggestion-thumbnail" src="${fixUrl(channel.thumbnail)}" alt="" loading="lazy">
      <div class="suggestion-info">
        <div class="suggestion-name">${escapeHtml(channel.name)}</div>
        <div class="suggestion-subs">${channel.subscriberCount || ''}</div>
      </div>
    </div>
  `).join('');

  // Scroll focused into view
  const focused = suggestionsList.querySelector('.focused');
  if (focused) {
    focused.scrollIntoView({ block: 'nearest' });
  }
}

// Close suggestions modal
function closeSuggestions() {
  isSuggestionsOpen = false;
  suggestionsModal.classList.remove('visible');
  channelSuggestions = [];
}

// Load more channels (for infinite scroll)
async function loadMoreChannels() {
  if (isLoadingMore || currentTab !== 'channels') return;

  isLoadingMore = true;

  try {
    const result = await sendMessage({ type: 'GET_MORE_CHANNELS' });
    if (result.success && result.data.length > 0) {
      for (const channel of result.data) {
        if (!getChannelById(channel.id)) {
          channels.push(channel);
        }
      }
      rebuildChannelMap();
      channelsCountEl.textContent = channels.length;
      renderChannels();
    }
  } catch (e) {
    warnLog('Load more channels failed:', e);
  } finally {
    isLoadingMore = false;
  }
}

// Toggle selection
function toggleSelection(index) {
  if (selectedIndices.has(index)) {
    selectedIndices.delete(index);
  } else {
    selectedIndices.add(index);
  }
}

// Get videos to operate on (selected or focused)
function getTargetVideos() {
  if (selectedIndices.size > 0) {
    return Array.from(selectedIndices).map(i => filteredVideos[i]).filter(Boolean);
  }
  return filteredVideos[focusedIndex] ? [filteredVideos[focusedIndex]] : [];
}

async function syncCurrentListFromYouTube() {
  if (currentTab === 'watchlater') {
    const response = await sendMessage({ type: 'GET_WATCH_LATER' });
    if (response.success) {
      watchLaterVideos = response.data || [];
      videos = watchLaterVideos;
      watchLaterCountEl.textContent = watchLaterVideos.length;
      renderVideos();
    }
    return;
  }

  if (currentTab === 'playlists' && playlistBrowserLevel === 'videos' && activePlaylistId) {
    const response = await sendMessage({ type: 'GET_PLAYLIST_VIDEOS', playlistId: activePlaylistId });
    if (response.success) {
      playlistVideos = response.data || [];
      videos = playlistVideos;
      renderVideos();
    }
  }
}

// Save state for undo
function saveUndoState(action, data) {
  // Always save full state for proper restoration
  undoStack.push({
    action,
    data,
    originalVideos: [...videos],
    originalFocusedIndex: focusedIndex,
    originalSelectedIndices: new Set(selectedIndices),
    timestamp: Date.now()
  });
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }
}

// Undo last action
async function undo() {
  if (undoStack.length === 0) {
    showToast('Nothing to undo', 'info');
    return;
  }

  const lastAction = undoStack.pop();
  setStatus(`Undoing ${lastAction.action}...`, 'loading');

  try {
    switch (lastAction.action) {
      case 'delete': {
        // Re-add deleted videos to Watch Later and restore position
        let restored = 0;
        for (const video of lastAction.data.videos) {
          try {
            const result = await sendMessage({
              type: 'ADD_TO_PLAYLIST',
              videoId: video.id,
              playlistId: 'WL',
            });
            if (result.success) {
              restored++;
            }
          } catch (e) {
            errorLog('Restore failed:', e);
          }
        }
        // Restore local state
        videos = lastAction.originalVideos;
        focusedIndex = lastAction.originalFocusedIndex;
        selectedIndices = lastAction.originalSelectedIndices;
        renderVideos();
        showToast(`Restored ${restored}/${lastAction.data.videos.length} videos`, restored > 0 ? 'success' : 'error');
        break;
      }
      case 'move_to_playlist': {
        // Move videos back to Watch Later from target playlist
        let restored = 0;
        for (const video of lastAction.data.videos) {
          try {
            const addResult = await sendMessage({
              type: 'ADD_TO_PLAYLIST',
              videoId: video.id,
              playlistId: 'WL',
            });
            if (addResult.success) {
              restored++;
            }
          } catch (e) {
            errorLog('Restore failed:', e);
          }
        }
        // Restore local state
        videos = lastAction.originalVideos;
        focusedIndex = lastAction.originalFocusedIndex;
        selectedIndices = lastAction.originalSelectedIndices;
        renderVideos();
        showToast(`Restored ${restored}/${lastAction.data.videos.length} videos`, restored > 0 ? 'success' : 'error');
        break;
      }
      case 'move_to_top':
      case 'move_to_bottom':
      case 'move_up':
      case 'move_down': {
        // Restore local state
        videos = lastAction.originalVideos;
        focusedIndex = lastAction.originalFocusedIndex;
        selectedIndices = lastAction.originalSelectedIndices;
        renderVideos();
        await syncCurrentListFromYouTube();
        showToast('Position restored and synced with YouTube', 'success');
        break;
      }
      case 'delete_from_playlist': {
        // Re-add deleted videos to the playlist
        let restored = 0;
        for (const video of lastAction.data.videos) {
          try {
            const result = await sendMessage({
              type: 'ADD_TO_PLAYLIST',
              videoId: video.id,
              playlistId: lastAction.data.playlistId,
            });
            if (result.success) {
              restored++;
            }
          } catch (e) {
            errorLog('Restore to playlist failed:', e);
          }
        }
        // Restore local state
        videos = lastAction.originalVideos;
        playlistVideos = lastAction.originalVideos;
        focusedIndex = lastAction.originalFocusedIndex;
        selectedIndices = lastAction.originalSelectedIndices;
        renderVideos();
        showToast(`Restored ${restored}/${lastAction.data.videos.length} video(s) to playlist`, restored > 0 ? 'success' : 'error');
        break;
      }
      default:
        showToast('Cannot undo this action', 'error');
    }
  } catch (error) {
    errorLog('Undo error:', error);
    showToast('Undo failed', 'error');
  }

  setStatus('Ready');
}

// Operations
async function deleteVideos() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  saveUndoState('delete', { videos: [...targets] });

  // Optimistically update UI immediately
  const targetIds = new Set(targets.map(v => v.id));
  videos = videos.filter(v => !targetIds.has(v.id));

  // Exit visual mode after delete
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  focusedIndex = Math.min(focusedIndex, Math.max(0, videos.length - 1));
  renderVideos();

  // Show initial toast - user can continue immediately
  showToast(`Deleting ${targets.length} video(s)...`);
  setStatus(`Deleting ${targets.length} video(s)...`);

  // Process API calls in background
  (async () => {
    const results = await runWithConcurrency(targets, async video => removeVideoFromWatchLater(video));
    const errors = results
      .filter(r => r && !r.success && r.error)
      .map(r => r.error);
    // Note: YouTube often returns 409 errors but still processes requests successfully
    if (errors.length > 0 && !errors.every(e => e.includes('409'))) {
      warnLog('Delete had non-409 errors:', errors);
      showToast(`Deleted with ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Deleted ${targets.length} video(s)`, 'success');
    }
    setStatus('Ready');
  })();
}

/**
 * Delete videos from the currently active playlist (Level 2 view).
 * Optimistically updates UI then processes API calls in background.
 */
async function deleteFromPlaylist() {
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save undo state
  saveUndoState('delete_from_playlist', {
    videos: targets,
    playlistId: activePlaylistId,
  });

  // Optimistically update UI
  const targetIds = new Set(targets.map(v => v.id));
  playlistVideos = playlistVideos.filter(v => !targetIds.has(v.id));
  videos = playlistVideos;

  // Exit visual mode
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  focusedIndex = Math.min(focusedIndex, Math.max(0, videos.length - 1));
  renderVideos();

  showToast(`Removing ${targets.length} video(s)...`);
  setStatus(`Removing ${targets.length} video(s)...`, 'loading');

  // Process API calls in background
  (async () => {
    const results = await runWithConcurrency(
      targets,
      async video => removeVideoFromPlaylist(video, activePlaylistId)
    );
    const errors = results
      .filter(r => r && !r.success && r.error)
      .map(r => r.error);
    if (errors.length > 0 && !errors.every(e => e.includes('409'))) {
      warnLog('Remove from playlist had errors:', errors);
      showToast(`Removed with ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Removed ${targets.length} video(s) from playlist`, 'success');
    }
    setStatus('Ready');
  })();
}

async function createNewPlaylist() {
  const title = await openInputDialog({
    title: 'Create Playlist',
    message: 'Enter a name for the new playlist.',
    placeholder: 'Playlist name',
    confirmText: 'Create',
  });
  if (!title || !title.trim()) return;

  const trimmedTitle = title.trim();
  setStatus('Creating playlist...', 'loading');

  try {
    const result = await sendMessage({
      type: 'CREATE_PLAYLIST',
      title: trimmedTitle,
    });

    if (result.success && result.playlistId) {
      const newPlaylist = {
        id: result.playlistId,
        title: trimmedTitle,
        videoCount: 0,
      };
      playlists = [...playlists, newPlaylist];
      rebuildPlaylistMap();
      playlistsCountEl.textContent = playlists.length;
      // Clear search so the new playlist is visible
      searchQuery = '';
      searchInput.value = '';
      focusedIndex = playlists.length - 1;
      renderPlaylistBrowser();
      showToast(`Created "${trimmedTitle}"`, 'success');
    } else {
      showToast('Failed to create playlist', 'error');
    }
  } catch (error) {
    errorLog('Create playlist error:', error);
    showToast('Failed to create playlist', 'error');
  }
  setStatus('Ready');
}

async function deleteSelectedPlaylist() {
  const playlist = filteredPlaylists[focusedIndex];
  if (!playlist) return;

  const confirmed = await openConfirmDialog({
    title: 'Delete Playlist',
    message: `Delete "${playlist.title}"? This action cannot be undone.`,
    confirmText: 'Delete',
  });
  if (!confirmed) return;

  setStatus('Deleting playlist...', 'loading');

  try {
    const result = await sendMessage({
      type: 'DELETE_PLAYLIST',
      playlistId: playlist.id,
    });

    if (result.success) {
      playlists = playlists.filter(p => p.id !== playlist.id);
      rebuildPlaylistMap();
      playlistsCountEl.textContent = playlists.length;
      focusedIndex = Math.min(focusedIndex, Math.max(0, playlists.length - 1));
      renderPlaylistBrowser();
      showToast(`Deleted "${playlist.title}"`, 'success');
    } else {
      showToast('Failed to delete playlist', 'error');
    }
  } catch (error) {
    errorLog('Delete playlist error:', error);
    showToast('Failed to delete playlist', 'error');
  }
  setStatus('Ready');
}

async function renameSelectedPlaylist() {
  const playlist = filteredPlaylists[focusedIndex];
  if (!playlist) return;

  const newTitle = await openInputDialog({
    title: 'Rename Playlist',
    message: `Current name: ${playlist.title}`,
    defaultValue: playlist.title,
    confirmText: 'Rename',
  });
  if (!newTitle || !newTitle.trim() || newTitle.trim() === playlist.title) return;

  const trimmedTitle = newTitle.trim();
  setStatus('Renaming playlist...', 'loading');

  try {
    const result = await sendMessage({
      type: 'RENAME_PLAYLIST',
      playlistId: playlist.id,
      newTitle: trimmedTitle,
    });

    if (result.success) {
      // Update local state
      const playlistInMain = playlists.find(p => p.id === playlist.id);
      if (playlistInMain) {
        playlistInMain.title = trimmedTitle;
      }
      renderPlaylistBrowser();
      showToast(`Renamed to "${trimmedTitle}"`, 'success');
    } else {
      showToast('Failed to rename playlist', 'error');
    }
  } catch (error) {
    errorLog('Rename playlist error:', error);
    showToast('Failed to rename playlist', 'error');
  }
  setStatus('Ready');
}

async function movePlaylistVideoUp() {
  if (currentTab !== 'playlists' || playlistBrowserLevel !== 'videos') return;
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if first video is selected
  const firstTargetIndex = filteredVideos.findIndex(v => v.id === targets[0].id);
  if (firstTargetIndex === 0) {
    showToast('Already at the top', 'info');
    return;
  }

  // Get the video that will be the new successor (one above the first selected)
  const targetSuccessor = filteredVideos[firstTargetIndex - 1];
  if (!targetSuccessor) return;

  // Optimistic UI update
  const targetIds = new Set(targets.map(v => v.id));
  const nonTargets = playlistVideos.filter(v => !targetIds.has(v.id));
  const successorIndexInFull = nonTargets.findIndex(v => v.id === targetSuccessor.id);

  // Remove targets from their current positions
  const remaining = playlistVideos.filter(v => !targetIds.has(v.id));
  // Insert targets before the successor
  remaining.splice(successorIndexInFull, 0, ...targets);
  playlistVideos = remaining;
  videos = playlistVideos;

  // Move focus up
  focusedIndex = Math.max(focusedIndex - 1, 0);
  renderVideos();

  // API call in background (move in reverse order to maintain relative order)
  showToast(`Moving ${targets.length} video(s) up...`);

  Promise.all(
    [...targets].reverse().map(video =>
      sendMessage({
        type: 'MOVE_PLAYLIST_VIDEO',
        playlistId: activePlaylistId,
        setVideoId: video.setVideoId,
        targetSetVideoId: targetSuccessor.setVideoId,
      }).catch(e => {
        errorLog('Move playlist video error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Some moves failed`, 'error');
    }
  });
}

async function movePlaylistVideoDown() {
  if (currentTab !== 'playlists' || playlistBrowserLevel !== 'videos') return;
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if last video is selected
  const lastTargetIndex = filteredVideos.findIndex(v => v.id === targets[targets.length - 1].id);
  if (lastTargetIndex === filteredVideos.length - 1) {
    showToast('Already at the bottom', 'info');
    return;
  }

  // Get the video that will come after the moved block (two positions down from last selected)
  const targetSuccessor = filteredVideos[lastTargetIndex + 2];
  if (!targetSuccessor) {
    // Moving to the very end - need special handling
    showToast('Already at the bottom', 'info');
    return;
  }

  // Optimistic UI update
  const targetIds = new Set(targets.map(v => v.id));
  const remaining = playlistVideos.filter(v => !targetIds.has(v.id));
  const successorIndexInRemaining = remaining.findIndex(v => v.id === targetSuccessor.id);

  // Insert targets before the successor
  remaining.splice(successorIndexInRemaining, 0, ...targets);
  playlistVideos = remaining;
  videos = playlistVideos;

  // Move focus down
  focusedIndex = Math.min(focusedIndex + 1, playlistVideos.length - 1);
  renderVideos();

  // API call in background (move in reverse order to maintain relative order)
  showToast(`Moving ${targets.length} video(s) down...`);

  Promise.all(
    [...targets].reverse().map(video =>
      sendMessage({
        type: 'MOVE_PLAYLIST_VIDEO',
        playlistId: activePlaylistId,
        setVideoId: video.setVideoId,
        targetSetVideoId: targetSuccessor.setVideoId,
      }).catch(e => {
        errorLog('Move playlist video error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Some moves failed`, 'error');
    }
  });
}

async function movePlaylistVideoToTop() {
  if (currentTab !== 'playlists' || playlistBrowserLevel !== 'videos') return;
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if already at top
  const firstTargetIndex = filteredVideos.findIndex(v => v.id === targets[0].id);
  if (firstTargetIndex === 0) {
    showToast('Already at the top', 'info');
    return;
  }

  // Get the first non-target video (will be the new successor)
  const targetIds = new Set(targets.map(v => v.id));
  const firstNonTargetVideo = playlistVideos.find(v => !targetIds.has(v.id));
  if (!firstNonTargetVideo) return;

  // Save for undo
  saveUndoState('move_to_top', { videos: targets });

  // Optimistic UI update - move targets to top
  playlistVideos = playlistVideos.filter(v => !targetIds.has(v.id));
  playlistVideos = [...targets, ...playlistVideos];
  videos = playlistVideos;

  // Clear selection and focus on first moved item
  selectedIndices.clear();
  visualModeStart = null;
  visualBlockMode = false;
  updateMode();
  focusedIndex = 0;
  renderVideos();

  showToast(`Moving ${targets.length} video(s) to top...`);

  // API call in background
  Promise.all(
    [...targets].reverse().map(video =>
      sendMessage({
        type: 'MOVE_PLAYLIST_VIDEO',
        playlistId: activePlaylistId,
        setVideoId: video.setVideoId,
        targetSetVideoId: firstNonTargetVideo.setVideoId,
      }).catch(e => {
        errorLog('Move to top error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to top had errors`, 'error');
    } else {
      showToast('Moved to top', 'success');
    }
  });
}

async function movePlaylistVideoToBottom() {
  if (currentTab !== 'playlists' || playlistBrowserLevel !== 'videos') return;
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if already at bottom
  const lastTargetIndex = filteredVideos.findIndex(v => v.id === targets[targets.length - 1].id);
  if (lastTargetIndex === filteredVideos.length - 1) {
    showToast('Already at the bottom', 'info');
    return;
  }

  // Save for undo
  saveUndoState('move_to_bottom', { videos: targets });

  // Optimistic UI update - move targets to bottom
  const targetIds = new Set(targets.map(v => v.id));
  playlistVideos = playlistVideos.filter(v => !targetIds.has(v.id));
  playlistVideos = [...playlistVideos, ...targets];
  videos = playlistVideos;

  // Clear selection and focus on first moved item
  selectedIndices.clear();
  visualModeStart = null;
  visualBlockMode = false;
  updateMode();
  focusedIndex = videos.length - targets.length;
  renderVideos();

  showToast(`Moving ${targets.length} video(s) to bottom...`);

  // API call - move to after the last video
  // Since we're moving to the very end, we need to use a different approach
  // We'll move each video to be after the current last video
  const moves = [];
  for (let i = 0; i < targets.length; i++) {
    // For moving to bottom, we don't have a successor, so we'll need to move them one by one
    // This is a limitation of the YouTube API - we can only move before a video
    moves.push(
      sendMessage({
        type: 'MOVE_PLAYLIST_VIDEO',
        playlistId: activePlaylistId,
        setVideoId: targets[i].setVideoId,
        targetSetVideoId: null, // Will be interpreted as move to end
      }).catch(e => {
        errorLog('Move to bottom error:', e);
        return { success: false, error: String(e) };
      })
    );
  }

  Promise.all(moves).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to bottom had errors`, 'error');
    } else {
      showToast('Moved to bottom', 'success');
    }
  });
}

function cycleSortMode() {
  if (currentTab !== 'playlists' || playlistBrowserLevel !== 'list') return;

  const modes = ['default', 'alpha', 'alpha-reverse', 'count-desc', 'count-asc'];
  const currentIndex = modes.indexOf(playlistSortMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  playlistSortMode = modes[nextIndex];

  // Persist to chrome.storage
  savePlaylistSortPref();

  // Update display
  renderPlaylistBrowser();

  // Show toast with current sort mode
  const modeNames = {
    'default': 'Default order',
    'alpha': 'A-Z',
    'alpha-reverse': 'Z-A',
    'count-desc': 'Most videos first',
    'count-asc': 'Fewest videos first',
  };
  showToast(`Sort: ${modeNames[playlistSortMode]}`, 'info');
}

function applySortToPlaylists(playlistsToSort) {
  const sorted = [...playlistsToSort];

  switch (playlistSortMode) {
    case 'alpha':
      sorted.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      break;
    case 'alpha-reverse':
      sorted.sort((a, b) => b.title.toLowerCase().localeCompare(a.title.toLowerCase()));
      break;
    case 'count-desc':
      sorted.sort((a, b) => (b.videoCount || 0) - (a.videoCount || 0));
      break;
    case 'count-asc':
      sorted.sort((a, b) => (a.videoCount || 0) - (b.videoCount || 0));
      break;
    case 'default':
    default:
      // Return as-is (YouTube's original order)
      break;
  }

  return sorted;
}

/**
 * Open the bulk purge confirmation dialog showing all watched videos
 */
function openPurgeDialog() {
  const purgeModal = document.getElementById('purge-modal');
  if (purgeModal.style.display === 'flex') return;

  const watchedVideos = videos.filter(v => !hiddenVideoIds.has(v.id) && isFullyWatched(v));
  if (watchedVideos.length === 0) {
    showToast('No watched videos to remove', 'info');
    return;
  }
  const purgeList = document.getElementById('purge-list');
  const purgeCount = document.getElementById('purge-count');

  purgeCount.textContent = `${watchedVideos.length} video(s)`;
  purgeList.innerHTML = watchedVideos.map(video => {
    const progress = getWatchedProgress(video);
    return `
      <div class="purge-item">
        <div>
          <div class="purge-item-title">${escapeHtml(video.title)}</div>
          <div class="purge-item-channel">${escapeHtml(video.channel)}</div>
        </div>
        <div class="purge-item-progress">${progress}%</div>
      </div>
    `;
  }).join('');

  purgeModal.style.display = 'flex';

  const confirmBtn = document.getElementById('purge-confirm');
  const cancelBtn = document.getElementById('purge-cancel');

  const cleanup = () => {
    purgeModal.style.display = 'none';
    confirmBtn.removeEventListener('click', onConfirm);
    cancelBtn.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey, true);
  };

  const onConfirm = () => {
    cleanup();
    executePurge(watchedVideos);
  };

  const onCancel = () => {
    cleanup();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm();
    }
  };

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey, true);
}

/**
 * Execute the bulk purge — remove all watched videos from Watch Later
 */
async function executePurge(watchedVideos) {
  setStatus(`Removing ${watchedVideos.length} watched videos...`, 'loading');

  const results = await runWithConcurrency(watchedVideos, async video => removeVideoFromWatchLater(video));
  const removedVideos = watchedVideos.filter((_, index) => results[index]?.success);
  const removed = removedVideos.length;

  // Remove from local state
  const removedIds = new Set(removedVideos.map(v => v.id));
  videos = videos.filter(v => !removedIds.has(v.id));
  watchLaterVideos = watchLaterVideos.filter(v => !removedIds.has(v.id));

  // Push undo entry using saveUndoState pattern
  if (removedVideos.length > 0) {
    saveUndoState('delete', { videos: [...removedVideos] });
  }

  selectedIndices.clear();
  renderVideos();
  // Clamp after renderVideos recomputes filteredVideos
  focusedIndex = Math.min(focusedIndex, Math.max(0, filteredVideos.length - 1));
  renderVideos();
  setStatus(`Removed ${removed} watched video(s)`, 'success');
  showToast(`Purged ${removed} watched video(s)`, 'success');
}

async function moveToTop() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  saveUndoState('move_to_top', { targets: [...targets] });

  // Save selection info before clearing - we want to focus on what was the next item after the selection
  const maxSelectedIndex = selectedIndices.size > 0
    ? Math.max(...selectedIndices)
    : focusedIndex;

  // Optimistically update UI immediately - move targets to top in order
  const targetIds = new Set(targets.map(v => v.id));
  videos = videos.filter(v => !targetIds.has(v.id));
  videos = [...targets, ...videos];

  // Exit visual mode after move
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  // Items after selection stay at their original positions (left shift from removal + right shift from prepend = net 0)
  // So the next-in-line item is at maxSelectedIndex + 1 (accounting for the prepended items)
  focusedIndex = Math.min(maxSelectedIndex + 1, videos.length - 1);
  renderVideos();

  // Show initial toast - user can continue immediately
  showToast(`Moving ${targets.length} video(s) to top...`);
  setStatus(`Moving ${targets.length} video(s) to top...`);

  // Process API calls in background - move in reverse order to maintain relative order
  const firstNonTargetVideo = videos.find(v => !targetIds.has(v.id));

  (async () => {
    const results = await runWithConcurrency(
      [...targets].reverse(),
      async video => sendMessage({
        type: 'MOVE_TO_TOP',
        setVideoId: video.setVideoId,
        firstSetVideoId: firstNonTargetVideo?.setVideoId,
      }),
      { concurrency: 1 }
    );
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to top had ${errors.length} error(s)`, 'warning');
    } else {
      showToast('Moved to top', 'success');
    }
    setStatus('Ready');
  })();
}

async function moveWatchLaterVideoUp() {
  if (currentTab !== 'watchlater') return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if first video is selected
  const firstTargetIndex = filteredVideos.findIndex(v => v.id === targets[0].id);
  if (firstTargetIndex === 0) {
    showToast('Already at the top', 'info');
    return;
  }

  // Get the video that will be the new successor (one above the first selected)
  const targetSuccessor = filteredVideos[firstTargetIndex - 1];
  if (!targetSuccessor) return;

  // Save for undo
  saveUndoState('move_up', { videos: targets });

  // Optimistic UI update
  const targetIds = new Set(targets.map(v => v.id));
  const nonTargets = videos.filter(v => !targetIds.has(v.id));
  const successorIndexInFull = nonTargets.findIndex(v => v.id === targetSuccessor.id);

  // Remove targets and insert before successor
  const remaining = videos.filter(v => !targetIds.has(v.id));
  remaining.splice(successorIndexInFull, 0, ...targets);
  videos = remaining;

  // Move focus up
  focusedIndex = Math.max(focusedIndex - 1, 0);
  selectedIndices.clear();
  visualModeStart = null;
  visualBlockMode = false;
  updateMode();
  renderVideos();

  // API call in background
  showToast(`Moving ${targets.length} video(s) up...`);

  (async () => {
    const results = await runWithConcurrency(
      [...targets].reverse(),
      async video => sendMessage({
        type: 'MOVE_TO_TOP',
        setVideoId: video.setVideoId,
        firstSetVideoId: targetSuccessor.setVideoId,
      }),
      { concurrency: 1 }
    );
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Some moves failed`, 'error');
    }
  })();
}

async function moveWatchLaterVideoDown() {
  if (currentTab !== 'watchlater') return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Can't move if last video is selected
  const lastTargetIndex = filteredVideos.findIndex(v => v.id === targets[targets.length - 1].id);
  if (lastTargetIndex === filteredVideos.length - 1) {
    showToast('Already at the bottom', 'info');
    return;
  }

  // Get the video that will come after the moved block (two positions down from last selected)
  const targetSuccessor = filteredVideos[lastTargetIndex + 2];
  if (!targetSuccessor) {
    showToast('Already at the bottom', 'info');
    return;
  }

  // Save for undo
  saveUndoState('move_down', { videos: targets });

  // Optimistic UI update
  const targetIds = new Set(targets.map(v => v.id));
  const remaining = videos.filter(v => !targetIds.has(v.id));
  const successorIndexInRemaining = remaining.findIndex(v => v.id === targetSuccessor.id);

  // Insert targets before the successor
  remaining.splice(successorIndexInRemaining, 0, ...targets);
  videos = remaining;

  // Move focus down
  focusedIndex = Math.min(focusedIndex + 1, videos.length - 1);
  selectedIndices.clear();
  visualModeStart = null;
  visualBlockMode = false;
  updateMode();
  renderVideos();

  // API call in background
  showToast(`Moving ${targets.length} video(s) down...`);

  (async () => {
    const results = await runWithConcurrency(
      [...targets].reverse(),
      async video => sendMessage({
        type: 'MOVE_TO_TOP',
        setVideoId: video.setVideoId,
        firstSetVideoId: targetSuccessor.setVideoId,
      }),
      { concurrency: 1 }
    );
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Some moves failed`, 'error');
    }
  })();
}

async function moveToBottom() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  saveUndoState('move_to_bottom', { targets: [...targets] });

  // Save selection info before clearing - we want to focus on what was the next item after the selection
  const maxSelectedIndex = selectedIndices.size > 0
    ? Math.max(...selectedIndices)
    : focusedIndex;
  const selectionSize = selectedIndices.size > 0 ? selectedIndices.size : 1;

  // Optimistically update UI immediately - move targets to bottom in order
  const targetIds = new Set(targets.map(v => v.id));
  videos = videos.filter(v => !targetIds.has(v.id));
  videos = [...videos, ...targets];

  // Exit visual mode after move
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  // Items after selection shift left by selectionSize (since removed items go to end, not prepended)
  // So the next-in-line item is at (maxSelectedIndex + 1) - selectionSize
  focusedIndex = Math.max(0, Math.min(maxSelectedIndex + 1 - selectionSize, videos.length - 1));
  renderVideos();

  // Show initial toast - user can continue immediately
  showToast(`Moving ${targets.length} video(s) to bottom...`);
  setStatus(`Moving ${targets.length} video(s) to bottom...`);

  // Process API calls in background
  const lastNonTargetVideo = videos.filter(v => !targetIds.has(v.id)).pop();

  (async () => {
    const results = await runWithConcurrency(
      targets,
      async video => sendMessage({
        type: 'MOVE_TO_BOTTOM',
        setVideoId: video.setVideoId,
        lastSetVideoId: lastNonTargetVideo?.setVideoId,
      }),
      { concurrency: 1 }
    );
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to bottom had ${errors.length} error(s)`, 'warning');
    } else {
      showToast('Moved to bottom', 'success');
    }
    setStatus('Ready');
  })();
}

async function moveToPlaylist(playlistId) {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  const playlist = getPlaylistById(playlistId);
  saveUndoState('move_to_playlist', { videos: [...targets], playlistId, playlistTitle: playlist?.title });

  // Optimistically update UI immediately
  const targetIds = new Set(targets.map(v => v.id));
  videos = videos.filter(v => !targetIds.has(v.id));

  // Exit visual mode after move
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  focusedIndex = Math.min(focusedIndex, Math.max(0, videos.length - 1));
  renderVideos();

  // Show initial toast - user can continue immediately
  showToast(`Moving ${targets.length} video(s) to ${playlist?.title}...`);
  setStatus(`Moving ${targets.length} video(s) to ${playlist?.title}...`);

  // Process API calls in background
  (async () => {
    const results = await runWithConcurrency(targets, async (video) => (
      sendMessage({
        type: 'MOVE_TO_PLAYLIST',
        videoId: video.id,
        setVideoId: video.setVideoId,
        playlistId,
      })
    ));
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move had ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Moved ${targets.length} to ${playlist?.title}`, 'success');
    }
    setStatus('Ready');
  })();
}

// Add to playlist (for subscriptions - doesn't remove from current view)
async function addToPlaylist(playlistId) {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  const playlist = getPlaylistById(playlistId);
  setStatus(`Adding ${targets.length} video(s) to ${playlist?.title}...`);

  const results = await runWithConcurrency(targets, async (video) => addVideoToPlaylist(video, playlistId));
  const added = results.filter(r => r?.success).length;

  // Exit visual mode after adding
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  renderVideos();
  showToast(`Added ${added} video(s) to ${playlist?.title}`, added > 0 ? 'success' : 'error');
  setStatus('Ready');
}

// Modal
function openModal() {
  isModalOpen = true;
  modalFocusedIndex = 0;
  modalOverlay.classList.add('visible');
  renderModalPlaylists();
}

function closeModal() {
  isModalOpen = false;
  modalOverlay.classList.remove('visible');
}

// Render dynamic help modal content based on current tab
// Safe: all content is hardcoded static strings, no user input
function renderHelpModal() {
  const modalContent = helpModal.querySelector('.modal');
  if (!modalContent) return;

  // Define shortcuts by category for each tab
  const navigationShortcuts = [
    { keys: ['j', 'k'], desc: 'Move down/up' },
    { keys: ['gg', 'G'], desc: 'Go to top/bottom' },
    { keys: ['⌃d', '⌃u'], desc: 'Half page down/up' },
    { keys: ['/'], desc: 'Search' },
    { keys: ['Esc'], desc: 'Clear/Cancel' },
  ];

  const commonShortcuts = [
    { keys: ['o', 'Enter'], desc: 'Open in YouTube' },
    { keys: ['y'], desc: 'Copy URL' },
    { keys: ['Tab'], desc: 'Next/prev tab' },
    { keys: ['r'], desc: 'Refresh' },
    { keys: ['?'], desc: 'Toggle help' },
  ];

  let actionsShortcuts = [];
  let selectionShortcuts = [];
  let previewShortcuts = [];
  let tabTitle = '';

  if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
    tabTitle = 'Playlists';
    actionsShortcuts = [
      { keys: ['Enter'], desc: 'Open playlist' },
      { keys: ['n'], desc: 'New playlist' },
      { keys: ['⇧R'], desc: 'Rename playlist' },
      { keys: ['⇧S'], desc: 'Sort playlists' },
      { keys: ['x', 'd'], desc: 'Delete playlist' },
    ];
  } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
    tabTitle = 'Playlist Videos';
    selectionShortcuts = [
      { keys: ['v'], desc: 'Visual Line (range select)' },
      { keys: ['⌃v'], desc: 'Visual Block (toggle select)' },
      { keys: ['Space'], desc: 'Open video / select (in ⌃v)' },
      { keys: ['⌃a'], desc: 'Select all' },
    ];
    actionsShortcuts = [
      { keys: ['x', 'd'], desc: 'Remove from playlist' },
      { keys: ['z'], desc: 'Undo' },
      { keys: ['⇧J', '⇧K'], desc: 'Move video down/up' },
      { keys: ['t', 'b'], desc: 'Move to top/bottom' },
      { keys: ['m'], desc: 'Move to another playlist' },
      { keys: ['1-9'], desc: 'Quick move to playlist' },
      { keys: ['Backspace'], desc: 'Back to playlist list' },
    ];
  } else if (currentTab === 'watchlater') {
    tabTitle = 'Watch Later';
    selectionShortcuts = [
      { keys: ['v'], desc: 'Visual Line (range select)' },
      { keys: ['⌃v'], desc: 'Visual Block (toggle select)' },
      { keys: ['Space'], desc: 'Open video / select (in ⌃v)' },
      { keys: ['⌃a'], desc: 'Select all' },
    ];
    actionsShortcuts = [
      { keys: ['x', 'd'], desc: 'Delete' },
      { keys: ['m'], desc: 'Move to playlist' },
      { keys: ['1-9'], desc: 'Quick move to playlist' },
      { keys: ['⇧J', '⇧K'], desc: 'Move video down/up' },
      { keys: ['t', 'b'], desc: 'Move to top/bottom' },
      { keys: ['u', 'z'], desc: 'Undo' },
    ];
  } else if (currentTab === 'subscriptions') {
    tabTitle = 'Subscriptions';
    selectionShortcuts = [
      { keys: ['v'], desc: 'Visual Line (range select)' },
      { keys: ['⌃v'], desc: 'Visual Block (toggle select)' },
      { keys: ['Space'], desc: 'Toggle WL / select (in ⌃v)' },
      { keys: ['⌃a'], desc: 'Select all' },
    ];
    actionsShortcuts = [
      { keys: ['w'], desc: 'Add to Watch Later' },
      { keys: ['h'], desc: 'Hide video(s)' },
      { keys: ['f'], desc: 'Toggle WL filter' },
      { keys: ['m'], desc: 'Add to playlist' },
      { keys: ['1-9'], desc: 'Quick add to playlist' },
    ];
  } else if (currentTab === 'channels') {
    tabTitle = 'Channels';
    actionsShortcuts = [
      { keys: ['Space', 'p'], desc: 'Preview channel' },
      { keys: ['x', 'd'], desc: 'Unsubscribe (press twice)' },
      { keys: ['u', 'z'], desc: 'Undo unsubscribe' },
    ];
    previewShortcuts = [
      { keys: ['h', 'l'], desc: 'Scroll videos left/right' },
      { keys: ['0', '$'], desc: 'Jump to first/last video' },
      { keys: ['Enter', 'Space'], desc: 'Watch focused video' },
      { keys: ['q', 'Esc'], desc: 'Close preview' },
    ];
  }

  const renderShortcutGroup = (shortcuts) => shortcuts.map(s => `
    <div class="shortcut">
      ${s.keys.map(k => `<span class="key">${escapeHtml(k)}</span>`).join('')}
      <span class="shortcut-desc">${escapeHtml(s.desc)}</span>
    </div>
  `).join('');

  // Build modal content dynamically
  let leftColumn = `
    <h4 style="color: var(--text-muted); font-size: 11px; margin-bottom: 8px;">NAVIGATION</h4>
    <div class="shortcuts">${renderShortcutGroup(navigationShortcuts)}</div>
  `;

  if (selectionShortcuts.length > 0) {
    leftColumn += `
      <h4 style="color: var(--text-muted); font-size: 11px; margin: 16px 0 8px;">SELECTION</h4>
      <div class="shortcuts">${renderShortcutGroup(selectionShortcuts)}</div>
    `;
  }

  if (previewShortcuts.length > 0) {
    leftColumn += `
      <h4 style="color: var(--text-muted); font-size: 11px; margin: 16px 0 8px;">PREVIEW MODAL</h4>
      <div class="shortcuts">${renderShortcutGroup(previewShortcuts)}</div>
    `;
  }

  let rightColumn = '';
  if (actionsShortcuts.length > 0) {
    rightColumn += `
      <h4 style="color: var(--text-muted); font-size: 11px; margin-bottom: 8px;">${escapeHtml(tabTitle.toUpperCase())} ACTIONS</h4>
      <div class="shortcuts">${renderShortcutGroup(actionsShortcuts)}</div>
    `;
  }

  rightColumn += `
    <h4 style="color: var(--text-muted); font-size: 11px; margin: ${actionsShortcuts.length > 0 ? '16px' : '0'} 0 8px;">OTHER</h4>
    <div class="shortcuts">${renderShortcutGroup(commonShortcuts)}</div>
  `;

  modalContent.innerHTML = `
    <h2>Keyboard Shortcuts · ${escapeHtml(tabTitle)}</h2>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px;">
      <div>${leftColumn}</div>
      <div>${rightColumn}</div>
    </div>
    <div class="modal-close">Press <span class="key">?</span> or <span class="key">Esc</span> to close</div>
  `;
}

// Help modal
function toggleHelp() {
  isHelpOpen = !isHelpOpen;
  if (isHelpOpen) {
    renderHelpModal();
    helpModal.classList.add('visible');
  } else {
    helpModal.classList.remove('visible');
  }
}

function closeHelp() {
  isHelpOpen = false;
  helpModal.classList.remove('visible');
}

// Update visual selection (Visual Line mode only - extends selection as range)
function updateVisualSelection() {
  if (visualModeStart === null) return;
  // Never update range selection in Visual Block mode
  if (visualBlockMode) return;

  selectedIndices.clear();
  const start = Math.min(visualModeStart, focusedIndex);
  const end = Math.max(visualModeStart, focusedIndex);
  for (let i = start; i <= end; i++) {
    selectedIndices.add(i);
  }
  updateMode(); // Update mode indicator with current selection count
}

// Keyboard handling
document.addEventListener('keydown', (e) => {
  if (contextMenuEl?.classList.contains('visible')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideContextMenu();
      forceDashboardFocus();
    }
    return;
  }

  // Search input handling
  if (document.activeElement === searchInput) {
    if (e.key === 'Escape') {
      searchInput.blur();
      searchInput.value = '';
      searchQuery = '';
      searchContainer?.classList.remove('active');
      renderCurrentView();
    } else if (e.key === 'Enter') {
      searchInput.blur();
    }
    return;
  }

  // Channel preview modal handling
  if (isChannelPreviewOpen) {
    e.preventDefault();
    switch (e.key) {
      case 'Escape':
      case 'q':
        closeChannelPreview();
        break;
      case 'h':
      case 'ArrowLeft':
        enableKeyboardNavMode();
        scrollChannelVideos('left');
        break;
      case 'l':
      case 'ArrowRight':
        enableKeyboardNavMode();
        scrollChannelVideos('right');
        break;
      case '^':
      case '0':
        // Jump to first video (vim: beginning of line)
        enableKeyboardNavMode();
        channelVideoFocusIndex = 0;
        renderChannelVideos();
        break;
      case '$':
        // Jump to last video (vim: end of line)
        enableKeyboardNavMode();
        channelVideoFocusIndex = Math.max(0, currentChannelVideos.length - 1);
        renderChannelVideos();
        break;
      case 'Enter':
      case ' ':
        previewChannelVideo();
        break;
    }
    return;
  }

  // Help modal handling
  if (isHelpOpen) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      closeHelp();
    }
    return;
  }

  // Confirm modal handling
  if (isConfirmOpen) {
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'n') {
      closeConfirm(false);
    } else if (e.key === 'Enter' || e.key === 'y') {
      closeConfirm(true);
      if (confirmCallback) confirmCallback();
    }
    return;
  }

  // Suggestions modal handling
  if (isSuggestionsOpen) {
    e.preventDefault();
    if (e.key === 'Escape') {
      closeSuggestions();
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
      enableKeyboardNavMode();
      suggestionsFocusedIndex = Math.min(suggestionsFocusedIndex + 1, channelSuggestions.length - 1);
      renderSuggestions();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      enableKeyboardNavMode();
      suggestionsFocusedIndex = Math.max(suggestionsFocusedIndex - 1, 0);
      renderSuggestions();
    } else if (e.key === 'Enter') {
      const channel = channelSuggestions[suggestionsFocusedIndex];
      if (channel) {
        window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
      }
    }
    return;
  }

  // Modal handling
  if (isModalOpen) {
    e.preventDefault();
    if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
      enableKeyboardNavMode();
      modalFocusedIndex = Math.min(modalFocusedIndex + 1, currentModalItems.length - 1);
      renderModalPlaylists();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      enableKeyboardNavMode();
      modalFocusedIndex = Math.max(modalFocusedIndex - 1, 0);
      renderModalPlaylists();
    } else if (e.key === 'Enter') {
      closeModal();
      const item = currentModalItems[modalFocusedIndex];
      if (!item) return;
      if (item.id === 'WL') {
        addToWatchLater();
      } else if (currentTab === 'subscriptions') {
        addToPlaylist(item.id);
      } else {
        moveToPlaylist(item.id);
      }
    } else if (e.key >= '1' && e.key <= '9') {
      // Assign quick move number to focused playlist
      const num = e.key;
      const focusedPlaylist = currentModalItems[modalFocusedIndex];
      if (focusedPlaylist) {
        assignQuickMove(num, focusedPlaylist.id);
        showToast(`Assigned ${num} to "${focusedPlaylist.title}"`, 'success');
        renderModalPlaylists();
        renderPlaylists();
      }
    } else if (e.key === '0') {
      // Clear quick move assignment from focused playlist
      const focusedPlaylist = currentModalItems[modalFocusedIndex];
      if (focusedPlaylist) {
        const currentNum = getQuickMoveNumber(focusedPlaylist.id);
        if (currentNum) {
          delete quickMoveAssignments[currentNum];
          saveQuickMoveAssignments();
          showToast(`Cleared quick move from "${focusedPlaylist.title}"`, 'info');
          renderModalPlaylists();
          renderPlaylists();
        }
      }
    }
    return;
  }

  // Handle 'gg' for go to top
  if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
    if (pendingG) {
      // gg - go to top
      enableKeyboardNavMode();
      focusedIndex = 0;
      selectedIndices.clear();
      visualModeStart = null;
      visualBlockMode = false;
      renderCurrentView();
      pendingG = false;
    } else {
      pendingG = true;
      setTimeout(() => { pendingG = false; }, PENDING_G_TIMEOUT_MS);
    }
    return;
  }

  // Reset pending g on other keys
  if (pendingG && e.key !== 'g') {
    pendingG = false;
  }

  const deleteActionKey = mappedKey('delete', 'x');
  const moveActionKey = mappedKey('move', 'm');
  const refreshActionKey = mappedKey('refresh', 'r');

  // Main shortcuts
  if (e.key === '?') {
    e.preventDefault();
    toggleHelp();
  } else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key === 'Escape') {
    // Drill out of playlist (takes priority)
    if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      drillOutOfPlaylist();
      return;
    }

    // Cancel pending unsubscribe confirmation
    if (pendingUnsubscribe) {
      cancelUnsubscribeConfirm();
      return;
    }

    selectedIndices.clear();
    visualModeStart = null;
    visualBlockMode = false;
    searchQuery = '';
    searchInput.value = '';
    searchContainer?.classList.remove('active');
    updateMode();
    renderCurrentView();
  } else if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    enableKeyboardNavMode();
    // Cancel pending unsubscribe confirmation on navigation
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();

    const maxIndex = getMaxIndex();
    focusedIndex = Math.min(focusedIndex + 1, maxIndex);

    // Only extend selection in Visual Line mode (not Visual Block)
    if (visualModeStart !== null && !visualBlockMode && currentTab !== 'channels') {
      updateVisualSelection();
    }

    renderCurrentView();
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    enableKeyboardNavMode();
    // Cancel pending unsubscribe confirmation on navigation
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();

    focusedIndex = Math.max(focusedIndex - 1, 0);

    // Only extend selection in Visual Line mode (not Visual Block)
    if (visualModeStart !== null && !visualBlockMode && currentTab !== 'channels') {
      updateVisualSelection();
    }

    renderCurrentView();
  } else if (e.key === 'v' && e.ctrlKey) {
    // Visual Block mode (Ctrl+V) - non-consecutive multi-select with Space toggle
    e.preventDefault(); // Prevent paste
    if (currentTab === 'channels' || (currentTab === 'playlists' && playlistBrowserLevel === 'list')) return;
    if (visualModeStart === null) {
      visualModeStart = focusedIndex;
      visualBlockMode = true;
      selectedIndices.clear();
      selectedIndices.add(focusedIndex);
    } else {
      visualModeStart = null;
      visualBlockMode = false;
    }
    updateMode();
    renderVideos();
    setStatus(visualModeStart !== null ? 'Visual Block: Space toggle, j/k move, Esc exit' : 'Ready');
  } else if (e.key === 'G') {
    // Go to bottom
    enableKeyboardNavMode();
    const maxIndex = getMaxIndex();
    focusedIndex = maxIndex;
    selectedIndices.clear();
    visualModeStart = null;
    visualBlockMode = false;
    renderCurrentView();
  } else if (e.key === 'd' && e.ctrlKey) {
    // Ctrl+d: half page down (vim-style)
    e.preventDefault();
    enableKeyboardNavMode();
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();
    const maxIndex = getMaxIndex();
    const pageSize = Math.floor(window.innerHeight / VIDEO_ITEM_HEIGHT_PX / 2); // ~half visible items
    focusedIndex = Math.min(focusedIndex + pageSize, maxIndex);
    renderCurrentView();
  } else if (e.key === 'u' && e.ctrlKey) {
    // Ctrl+u: half page up (vim-style)
    e.preventDefault();
    enableKeyboardNavMode();
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();
    const pageSize = Math.floor(window.innerHeight / VIDEO_ITEM_HEIGHT_PX / 2);
    focusedIndex = Math.max(focusedIndex - pageSize, 0);
    renderCurrentView();
  } else if (e.key === 'K') {
    // Shift+K: move video(s) up (Watch Later and Playlists)
    e.preventDefault();
    if (currentTab === 'watchlater') {
      moveWatchLaterVideoUp();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      movePlaylistVideoUp();
    }
  } else if (e.key === 'J') {
    // Shift+J: move video(s) down (Watch Later and Playlists)
    e.preventDefault();
    if (currentTab === 'watchlater') {
      moveWatchLaterVideoDown();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      movePlaylistVideoDown();
    }
  } else if (e.key === ' ') {
    e.preventDefault();
    // In Visual Block mode: toggle selection for non-consecutive multi-select
    if (visualModeStart !== null && visualBlockMode && currentTab !== 'channels') {
      toggleSelection(focusedIndex);
      renderVideos();
    } else if (currentTab === 'subscriptions') {
      // Toggle Watch Later status for focused video
      toggleWatchLater();
    } else if (currentTab === 'channels') {
      // Preview channel (same as 'p')
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        openChannelPreview(channel);
      } else {
        showToast('No channel selected', 'info');
      }
    } else if (currentTab === 'watchlater') {
      // Open video preview for focused video
      const video = filteredVideos[focusedIndex];
      if (video && video.id) {
        showVideoPreview(video);
      } else {
        showToast('No video selected', 'info');
      }
    }
  } else if (e.key === 'v' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    // Visual Line mode (not for channels/playlist list) - range selection with j/k
    if (currentTab === 'channels' || (currentTab === 'playlists' && playlistBrowserLevel === 'list')) return;
    if (visualModeStart === null) {
      visualModeStart = focusedIndex;
      visualBlockMode = false;
      selectedIndices.clear();
      selectedIndices.add(focusedIndex);
    } else {
      visualModeStart = null;
      visualBlockMode = false;
    }
    updateMode();
    renderVideos();
    setStatus(visualModeStart !== null ? 'Visual Line: j/k extend range, Esc exit' : 'Ready');
  } else if (e.key === 'h') {
    // Hide video(s)
    if (currentTab === 'subscriptions') {
      toggleHideVideo();
    }
  } else if (e.key === 'f') {
    // Toggle Watch Later filter (subscriptions tab only)
    if (currentTab === 'subscriptions') {
      toggleHideWatchLater();
    }
  } else if (e.key === 'Tab') {
    // Cycle through tabs (SHIFT+TAB goes backwards)
    e.preventDefault();
    switchTab(e.shiftKey ? getPrevTab() : getNextTab());
  } else if (e.key === 'w' && !e.shiftKey) {
    // Toggle watched status (video views only, not playlist list)
    if (currentTab !== 'channels' && !(currentTab === 'playlists' && playlistBrowserLevel === 'list')) {
      toggleWatched();
    }
  } else if (e.key === 'H') {
    // Toggle hide watched (global)
    toggleHideWatched();
  } else if (e.key === 'W') {
    // Bulk purge watched videos
    if (currentTab === 'watchlater') {
      openPurgeDialog();
    } else {
      showToast('Bulk purge only available in Watch Later', 'info');
    }
  } else if (e.key === 'n') {
    if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
      createNewPlaylist();
    }
  } else if (e.key === 'R') {
    // Shift+R: Rename playlist
    if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
      renameSelectedPlaylist();
    }
  } else if (e.key === 'S') {
    // Shift+S: Sort playlists
    if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
      cycleSortMode();
    }
  } else if (e.key === 'T') {
    e.preventDefault();
    cycleTheme();
  } else if (e.key === deleteActionKey || e.key === 'x' || e.key === 'd' || e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (currentTab === 'watchlater') {
      deleteVideos();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
      deleteSelectedPlaylist();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      deleteFromPlaylist();
    } else if (currentTab === 'channels') {
      // Unsubscribe from focused channel
      const channel = filteredChannels[focusedIndex];
      if (channel) confirmUnsubscribe(channel);
    } else {
      showToast('Cannot delete from subscriptions feed', 'info');
    }
  } else if (e.key === 't') {
    if (currentTab === 'watchlater') {
      moveToTop();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      movePlaylistVideoToTop();
    }
  } else if (e.key === 'b') {
    if (currentTab === 'watchlater') {
      moveToBottom();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      movePlaylistVideoToBottom();
    }
  } else if (e.key === moveActionKey || e.key === 'm') {
    if (currentTab === 'watchlater' || currentTab === 'subscriptions') {
      openModal();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      openModal(); // Move to another playlist
    } else {
      showToast('Press w to add to Watch Later', 'info');
    }
  } else if (e.key >= '1' && e.key <= '9') {
    // Use quick move/add assignment
    if (currentTab === 'watchlater') {
      const playlist = getPlaylistByQuickMove(e.key);
      if (playlist) {
        if (playlist.id === 'WL') {
          showToast('Cannot move from Watch Later to Watch Later', 'info');
        } else {
          moveToPlaylist(playlist.id);
        }
      } else {
        showToast(`No playlist assigned to ${e.key}. Press m to assign.`, 'info');
      }
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      const playlist = getPlaylistByQuickMove(e.key);
      if (playlist) {
        if (playlist.id === activePlaylistId) {
          showToast('Cannot move to the same playlist', 'info');
        } else if (playlist.id === 'WL') {
          moveToPlaylist(playlist.id);
        } else {
          moveToPlaylist(playlist.id);
        }
      } else {
        showToast(`No playlist assigned to ${e.key}. Press m to assign.`, 'info');
      }
    } else if (currentTab === 'subscriptions') {
      const playlist = getPlaylistByQuickMove(e.key);
      if (playlist) {
        if (playlist.id === 'WL') {
          addToWatchLater();
        } else {
          addToPlaylist(playlist.id);
        }
      } else {
        showToast(`No playlist assigned to ${e.key}. Press m to assign.`, 'info');
      }
    }
  } else if (e.key === 'Enter') {
    if (currentTab === 'playlists' && playlistBrowserLevel === 'list') {
      const playlist = filteredPlaylists[focusedIndex];
      if (playlist) drillIntoPlaylist(playlist);
    } else if (currentTab === 'channels') {
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
      }
    } else {
      const video = filteredVideos[focusedIndex];
      if (video) {
        const url = currentTab === 'watchlater'
          ? getWatchLaterVideoUrl(video)
          : `https://www.youtube.com/watch?v=${video.id}`;
        window.open(url, '_blank');
      }
    }
  } else if (e.key === refreshActionKey || e.key === 'r') {
    loadData();
  } else if (e.key === 'I') {
    toggleSmartSort();
  } else if (e.key === 'e') {
    if (currentTab !== 'channels' && !(currentTab === 'playlists' && playlistBrowserLevel === 'list')) {
      editFocusedVideoAnnotation();
    }
  } else if (e.key === 'B') {
    exportBackup();
  } else if (e.key === 'L') {
    importBackup();
  } else if (e.key === 'p') {
    // Preview channel (channels tab only)
    if (currentTab === 'channels') {
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        openChannelPreview(channel);
      } else {
        showToast('No channel selected', 'info');
      }
    }
  } else if (e.key === 'z' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (currentTab === 'watchlater') {
      undo();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      undo();
    } else if (currentTab === 'channels') {
      undoChannelUnsubscribe();
    }
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (currentTab === 'watchlater') {
      undo();
    } else if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
      undo();
    } else if (currentTab === 'channels') {
      undoChannelUnsubscribe();
    }
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    // Select all
    for (let i = 0; i < filteredVideos.length; i++) {
      selectedIndices.add(i);
    }
    renderVideos();
  } else if (e.key === 'u' && !e.ctrlKey && !e.metaKey) {
    // u: undo (vim-style, alternative to z)
    e.preventDefault();
    if (currentTab === 'watchlater') {
      undo();
    } else if (currentTab === 'channels') {
      undoChannelUnsubscribe();
    }
  } else if (e.key === 'o') {
    // o: open in YouTube (vim-style)
    e.preventDefault();
    if (currentTab === 'channels') {
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
      }
    } else {
      const video = filteredVideos[focusedIndex];
      if (video) {
        const url = currentTab === 'watchlater'
          ? getWatchLaterVideoUrl(video)
          : `https://www.youtube.com/watch?v=${video.id}`;
        window.open(url, '_blank');
      }
    }
  } else if (e.key === 'y') {
    // y: yank/copy URL to clipboard (vim-style)
    e.preventDefault();
    let url = '';
    if (currentTab === 'channels') {
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        url = `https://www.youtube.com/channel/${channel.id}`;
      }
    } else {
      const video = filteredVideos[focusedIndex];
      if (video) {
        url = currentTab === 'watchlater'
          ? getWatchLaterVideoUrl(video)
          : `https://www.youtube.com/watch?v=${video.id}`;
      }
    }
    if (url) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('URL copied to clipboard', 'success');
      }).catch(() => {
        showToast('Failed to copy URL', 'error');
      });
    }
  }
});

// Search input
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  focusedIndex = 0;
  selectedIndices.clear();

  // Update visual indicator for active search
  if (searchQuery) {
    searchContainer?.classList.add('active');
  } else {
    searchContainer?.classList.remove('active');
  }

  renderCurrentView();
});

// Load data for current tab
async function loadData() {
  loadingEl.style.display = 'flex';
  videoList.innerHTML = '';

  const loadingLabels = {
    'watchlater': 'Watch Later',
    'subscriptions': 'Subscriptions',
    'playlists': 'Playlists',
    'channels': 'Channels'
  };
  const loadingLabel = loadingLabels[currentTab] || 'Data';
  loadingText.textContent = `Loading ${loadingLabel}...`;
  setStatus(`Loading ${loadingLabel}...`);

  try {
    // Load quick move assignments
    await loadQuickMoveAssignments();

    if (currentTab === 'watchlater') {
      // Load Watch Later and playlists
      const [videosResult, playlistsResult] = await Promise.all([
        sendMessage({ type: 'GET_WATCH_LATER' }),
        sendMessage({ type: 'GET_PLAYLISTS' }),
      ]);

      if (videosResult.success) {
        watchLaterVideos = videosResult.data;
        videos = watchLaterVideos;
        watchLaterCountEl.textContent = watchLaterVideos.length;
        renderVideos();
      } else {
        throw new Error(videosResult.error || 'Failed to load videos');
      }

      if (playlistsResult.success) {
        playlists = playlistsResult.data;
        rebuildPlaylistMap();
        renderPlaylists();
      }
      setStatus('Ready');
      showToast(`Loaded ${watchLaterVideos.length} videos`, 'success');
    } else if (currentTab === 'playlists') {
      // Load Playlists
      const playlistsResult = await sendMessage({ type: 'GET_PLAYLISTS' });

      if (playlistsResult.success) {
        playlists = playlistsResult.data;
        rebuildPlaylistMap();
        playlistsCountEl.textContent = playlists.length;

        // If in video view, reload that playlist
        if (playlistBrowserLevel === 'videos' && activePlaylistId) {
          const activePlaylist = playlists.find(p => p.id === activePlaylistId);
          if (activePlaylist) {
            await drillIntoPlaylist(activePlaylist);
          } else {
            drillOutOfPlaylist();
            renderPlaylistBrowser();
          }
        } else {
          renderPlaylistBrowser();
        }
        setStatus('Ready');
        showToast(`Loaded ${playlists.length} playlists`, 'success');
      } else {
        throw new Error(playlistsResult.error || 'Failed to load playlists');
      }
    } else if (currentTab === 'channels') {
      // Load Channels
      const channelsResult = await sendMessage({ type: 'GET_CHANNELS' });

      if (channelsResult.success) {
        channels = channelsResult.data;
        rebuildChannelMap();
        channelsCountEl.textContent = channels.length;
        renderChannels();
        setStatus('Ready');
        showToast(`Loaded ${channels.length} channels`, 'success');
      } else {
        throw new Error(channelsResult.error || 'Failed to load channels');
      }
    } else if (currentTab === 'subscriptions') {
      // Load Subscriptions
      const subsResult = await sendMessage({ type: 'GET_SUBSCRIPTIONS' });

      if (subsResult.success) {
        subscriptionVideos = subsResult.data;
        subscriptionsContinuationExhausted = false;
        setLoadMoreState('hidden');
        videos = subscriptionVideos;
        subscriptionsCountEl.textContent = subscriptionVideos.length;
        renderVideos();
        setStatus('Ready');
        showToast(`Loaded ${subscriptionVideos.length} videos`, 'success');
      } else {
        throw new Error(subsResult.error || 'Failed to load subscriptions');
      }
    }
  } catch (error) {
    errorLog('Load error:', error);
    setStatus(error.message, 'error');
    showLoadError(error.message);
  } finally {
    loadingEl.style.display = 'none';
  }
}

// Show load error in video list
function showLoadError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'empty-state';

  const msgDiv = document.createElement('div');
  msgDiv.textContent = `Failed to load: ${message}`;
  errorDiv.appendChild(msgDiv);

  const hintDiv = document.createElement('div');
  hintDiv.style.cssText = 'font-size: 11px; margin-top: 8px;';
  hintDiv.textContent = "Make sure you're logged into YouTube, then press r to retry.";
  errorDiv.appendChild(hintDiv);

  videoList.innerHTML = '';
  videoList.appendChild(errorDiv);
}

// Load all data on startup
async function loadAllData() {
  loadingEl.style.display = 'flex';
  videoList.innerHTML = '';
  loadingText.textContent = 'Loading current view...';
  setStatus('Loading current view...', 'loading');

  const prefetch = async () => {
    const tasks = [];

    if (currentTab !== 'watchlater') {
      tasks.push((async () => {
        const result = await sendMessage({ type: 'GET_WATCH_LATER' });
        if (result.success) {
          watchLaterVideos = result.data || [];
          watchLaterCountEl.textContent = watchLaterVideos.length;
        }
      })());
    }

    if (currentTab !== 'subscriptions') {
      tasks.push((async () => {
        const result = await sendMessage({ type: 'GET_SUBSCRIPTIONS' });
        if (result.success) {
          subscriptionVideos = result.data || [];
          subscriptionsCountEl.textContent = subscriptionVideos.length;
        }
      })());
    }

    if (currentTab !== 'channels') {
      tasks.push((async () => {
        const result = await sendMessage({ type: 'GET_CHANNELS' });
        if (result.success) {
          channels = result.data || [];
          rebuildChannelMap();
          channelsCountEl.textContent = channels.length;
        }
      })());
    }

    if (currentTab !== 'playlists') {
      tasks.push((async () => {
        const result = await sendMessage({ type: 'GET_PLAYLISTS' });
        if (result.success) {
          playlists = result.data || [];
          rebuildPlaylistMap();
          playlistsCountEl.textContent = playlists.length;
          renderPlaylists();
        }
      })());
    }

    await Promise.allSettled(tasks);

    if (subscriptionVideos.length > 0 && channels.length > 0) {
      const activityMap = deriveChannelActivity(subscriptionVideos);
      applyChannelActivity(channels, activityMap);
    }

    if (watchLaterVideos.length > 0 || subscriptionVideos.length > 0) {
      const allLoadedIds = new Set([...watchLaterVideos, ...subscriptionVideos].map(v => v.id));
      await pruneStaleOverrides(allLoadedIds);
    }
  };

  try {
    await loadNuTubeSettings();
    await Promise.all([
      loadLastTabPref(),
      loadQuickMoveAssignments(),
      loadHiddenVideos(),
      loadHideWatchLaterPref(),
      loadWatchedOverrides(),
      loadHideWatchedPref(),
      loadPlaylistSortPref(),
      loadThemePref(),
      loadSmartSortPref(),
      loadVideoAnnotations(),
    ]);

    updateTabStateUI(currentTab, 'auto');
    renderShortcuts();
    applyTheme();
    updateHideWatchedIndicator();

    await loadData();
    prefetch().catch(e => warnLog('Background prefetch failed:', e));
  } catch (error) {
    errorLog('Load error:', error);
    setStatus(error.message, 'error');
    showLoadError(error.message);
    loadingEl.style.display = 'none';
    return;
  }

  loadingEl.style.display = 'none';
}

// Tab click handlers
tabWatchLater.addEventListener('click', () => switchTab('watchlater'));
tabSubscriptions.addEventListener('click', () => switchTab('subscriptions'));
tabChannels.addEventListener('click', () => switchTab('channels'));
tabPlaylists.addEventListener('click', () => switchTab('playlists'));

tabStrip?.addEventListener('scroll', updateTabOverflowIndicators);
tabShiftBefore?.addEventListener('click', () => {
  if (!tabStrip) return;
  tabStrip.scrollBy({
    left: -Math.max(120, Math.floor(tabStrip.clientWidth * 0.75)),
    behavior: 'smooth',
  });
});
tabShiftAfter?.addEventListener('click', () => {
  if (!tabStrip) return;
  tabStrip.scrollBy({
    left: Math.max(120, Math.floor(tabStrip.clientWidth * 0.75)),
    behavior: 'smooth',
  });
});
window.addEventListener('resize', () => {
  updateTabRolodexClasses();
  updateTabOverflowIndicators();
});

// Breadcrumb click to return to playlist list
breadcrumbEl?.querySelector('.breadcrumb-root')?.addEventListener('click', () => {
  if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
    drillOutOfPlaylist();
  }
});

// Confirm modal button handlers
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmOk.addEventListener('click', () => {
  closeConfirm(true);
  if (confirmCallback) confirmCallback();
});

// Delegated list interactions (avoids re-binding per render for large lists)
videoList.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;

  const playlistItem = target.closest('.playlist-browser-item');
  if (playlistItem) {
    const index = parseInt(playlistItem.getAttribute('data-index') || '0', 10);
    focusedIndex = index;
    drillIntoPlaylist(filteredPlaylists[index]);
    return;
  }

  const channelItem = target.closest('.channel-item');
  if (channelItem) {
    const index = parseInt(channelItem.getAttribute('data-index') || '0', 10);
    focusedIndex = index;
    renderChannels();
    return;
  }

  const videoItem = target.closest('.video-item');
  if (videoItem) {
    const index = parseInt(videoItem.getAttribute('data-index') || '0', 10);
    if (e.shiftKey && focusedIndex !== index) {
      const start = Math.min(focusedIndex, index);
      const end = Math.max(focusedIndex, index);
      for (let i = start; i <= end; i++) {
        selectedIndices.add(i);
      }
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelection(index);
    } else {
      focusedIndex = index;
    }
    updateMode();
    renderVideos();
  }
});

videoList.addEventListener('dblclick', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;

  const channelItem = target.closest('.channel-item');
  if (channelItem) {
    const index = parseInt(channelItem.getAttribute('data-index') || '0', 10);
    const channel = filteredChannels[index];
    if (channel) {
      window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
    }
    return;
  }

  const videoItem = target.closest('.video-item');
  if (videoItem) {
    const index = parseInt(videoItem.getAttribute('data-index') || '0', 10);
    const video = filteredVideos[index];
    if (video) {
      const url = currentTab === 'watchlater'
        ? getWatchLaterVideoUrl(video)
        : `https://www.youtube.com/watch?v=${video.id}`;
      window.open(url, '_blank');
    }
  }
});

videoList.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (isModalOpen || isHelpOpen || isConfirmOpen || isSuggestionsOpen || isChannelPreviewOpen) {
    return;
  }

  const playlistItem = target.closest('.playlist-browser-item');
  if (playlistItem && currentTab === 'playlists' && playlistBrowserLevel === 'list') {
    const index = parseInt(playlistItem.getAttribute('data-index') || '-1', 10);
    const playlist = filteredPlaylists[index];
    if (!playlist) return;

    e.preventDefault();
    setSingleFocusedSelection(index);
    renderPlaylistBrowser();
    showContextMenu(e.clientX, e.clientY, buildPlaylistContextMenuItems(playlist));
    return;
  }

  const channelItem = target.closest('.channel-item');
  if (channelItem && currentTab === 'channels') {
    const index = parseInt(channelItem.getAttribute('data-index') || '-1', 10);
    const channel = filteredChannels[index];
    if (!channel) return;

    e.preventDefault();
    setSingleFocusedSelection(index);
    renderChannels();
    showContextMenu(e.clientX, e.clientY, buildChannelContextMenuItems(channel));
    return;
  }

  const videoItem = target.closest('.video-item');
  if (videoItem) {
    const index = parseInt(videoItem.getAttribute('data-index') || '-1', 10);
    const video = filteredVideos[index];
    if (!video) return;

    e.preventDefault();
    setSingleFocusedSelection(index);
    renderVideos();
    showContextMenu(e.clientX, e.clientY, buildVideoContextMenuItems(video));
    return;
  }

  hideContextMenu();
});

playlistList.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const playlistItem = target.closest('.playlist-item[data-playlist-id]');
  if (!playlistItem) return;
  const playlistId = playlistItem.getAttribute('data-playlist-id');
  if (playlistId) {
    moveToPlaylist(playlistId);
  }
});

modalPlaylists.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const item = target.closest('.modal-playlist');
  if (!item) return;

  const playlistId = item.getAttribute('data-playlist-id');
  if (!playlistId) return;

  closeModal();
  if (playlistId === 'WL') {
    addToWatchLater();
  } else if (currentTab === 'subscriptions') {
    addToPlaylist(playlistId);
  } else {
    moveToPlaylist(playlistId);
  }
});

suggestionsList.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const item = target.closest('.suggestion-item');
  if (!item) return;
  const index = parseInt(item.getAttribute('data-index') || '0', 10);
  const channel = channelSuggestions[index];
  if (channel) {
    window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
  }
});

contextMenuItemsEl?.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const actionButton = target.closest('.context-menu-item');
  if (!actionButton || actionButton.hasAttribute('disabled')) return;

  e.preventDefault();
  const actionIndex = parseInt(actionButton.getAttribute('data-action-index') || '-1', 10);
  if (actionIndex < 0) return;
  runContextMenuAction(actionIndex);
});

document.addEventListener('click', (e) => {
  if (!contextMenuEl?.classList.contains('visible')) return;
  if (e.target instanceof Node && contextMenuEl.contains(e.target)) return;
  hideContextMenu();
});

document.addEventListener('contextmenu', (e) => {
  if (!contextMenuEl?.classList.contains('visible')) return;
  if (e.defaultPrevented) return;
  if (e.target instanceof Node && contextMenuEl.contains(e.target)) return;
  hideContextMenu();
});

window.addEventListener('resize', hideContextMenu);

// Infinite scroll for subscriptions and channels
const videoListContainerEl = document.getElementById('video-list-container');
let scrollDebounceTimer = null;

videoListContainerEl.addEventListener('scroll', hideContextMenu, { passive: true });

videoListContainerEl.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = videoListContainerEl;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

  // Clear existing debounce timer
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer);
  }

  // Debounced scroll handler
  scrollDebounceTimer = setTimeout(() => {
    // Load more when user scrolls near bottom
    if (distanceFromBottom < INFINITE_SCROLL_THRESHOLD_PX) {
      if (currentTab === 'subscriptions') {
        loadMoreSubscriptions();
      } else if (currentTab === 'channels') {
        loadMoreChannels();
      }
    }
  }, SCROLL_DEBOUNCE_MS);
});

// Channel preview modal click-to-close handler
document.getElementById('channel-preview-modal').addEventListener('click', (e) => {
  if (e.target.classList.contains('preview-modal')) {
    closeChannelPreview();
  }
});

// Ensure keyboard bindings work when returning to the dashboard
// After opening a video in a new tab and returning, focus can be lost
function restoreFocus() {
  // Only restore focus if search isn't active
  if (document.activeElement !== searchInput) {
    forceDashboardFocus();
  }
}

window.addEventListener('focus', restoreFocus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Small delay to let the browser settle
    setTimeout(() => {
      restoreFocus();
      if (isSidePanelSurface) {
        requestDashboardFocus();
      }
    }, 50);
  }
});

// Also restore focus on any click in the app
document.querySelector('.app')?.addEventListener('click', (e) => {
  // Don't interfere with search input or buttons
  if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    restoreFocus();
  }
});

// Theme indicator click handler
document.getElementById('theme-indicator')?.addEventListener('click', cycleTheme);

// Apply theme early to prevent flash of wrong theme
chrome.storage.local.get(['themePref'], (result) => {
  const pref = result.themePref || 'auto';
  if (pref !== 'auto') {
    document.documentElement.setAttribute('data-theme', pref);
  }
});

// Initialize
renderShortcuts();
loadAllData();

if (isSidePanelSurface) {
  requestDashboardFocus();
}
