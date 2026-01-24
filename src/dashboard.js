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

// Playlist browser state (two-level drill-down)
let playlistBrowserLevel = 'list'; // 'list' (Level 1) or 'videos' (Level 2)
let activePlaylistId = null;
let activePlaylistTitle = '';
let playlistVideos = [];
let filteredPlaylists = [];

// Undo history
const undoStack = [];

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
const helpModal = document.getElementById('help-modal');
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
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
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
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
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
          { keys: ['r'], desc: 'Refresh' },
          { keys: ['Tab'], desc: 'Switch tab' },
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

function updateHideWatchedIndicator() {
  if (hideWatchedIndicatorEl) {
    hideWatchedIndicatorEl.classList.toggle('active', hideWatched);
  }
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
function switchTab(tab) {
  if (tab === currentTab) return;

  currentTab = tab;
  selectedIndices.clear();
  focusedIndex = 0;
  visualModeStart = null;
  visualBlockMode = false;
  searchQuery = '';
  searchInput.value = '';
  searchContainer?.classList.remove('active');

  // Update tab UI
  tabWatchLater.classList.toggle('active', tab === 'watchlater');
  tabSubscriptions.classList.toggle('active', tab === 'subscriptions');
  tabChannels.classList.toggle('active', tab === 'channels');
  tabPlaylists.classList.toggle('active', tab === 'playlists');
  renderShortcuts();

  // Hide breadcrumb when leaving playlists tab
  if (tab !== 'playlists') {
    breadcrumbEl.style.display = 'none';
    playlistBrowserLevel = 'list';
    activePlaylistId = null;
    activePlaylistTitle = '';
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
  setStatus('Ready');
}

// Playlist browser rendering (Level 1)
function renderPlaylistBrowser() {
  // Apply search filter to playlists
  const query = searchQuery.toLowerCase();
  filteredPlaylists = query
    ? playlists.filter(p => p.title.toLowerCase().includes(query))
    : [...playlists];

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

  // Add click handlers
  const items = videoList.querySelectorAll('.playlist-browser-item');
  items.forEach((item, index) => {
    item.addEventListener('click', () => {
      focusedIndex = index;
      drillIntoPlaylist(filteredPlaylists[index]);
    });
  });

  // Scroll focused into view
  const focusedEl = videoList.querySelector('.playlist-browser-item.focused');
  if (focusedEl) {
    focusedEl.scrollIntoView({ block: 'nearest' });
  }
}

async function drillIntoPlaylist(playlist) {
  if (!playlist) return;

  activePlaylistId = playlist.id;
  activePlaylistTitle = playlist.title;
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
  activePlaylistTitle = '';
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
  if (currentTab === 'watchlater') return 'subscriptions';
  if (currentTab === 'subscriptions') return 'channels';
  if (currentTab === 'channels') return 'playlists';
  return 'watchlater';
}

// Get previous tab in cycle (for SHIFT+TAB)
function getPrevTab() {
  if (currentTab === 'watchlater') return 'playlists';
  if (currentTab === 'playlists') return 'channels';
  if (currentTab === 'channels') return 'subscriptions';
  return 'watchlater';
}

// Add to Watch Later (for subscriptions tab)
async function addToWatchLater() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  setStatus(`Adding ${targets.length} video(s) to Watch Later...`, 'loading');

  let added = 0;
  for (const video of targets) {
    try {
      const result = await sendMessage({
        type: 'ADD_TO_WATCH_LATER',
        videoId: video.id,
      });
      if (result.success) {
        added++;
        // Add to local watch later cache
        if (!watchLaterVideos.find(v => v.id === video.id)) {
          watchLaterVideos.unshift(video);
          watchLaterCountEl.textContent = watchLaterVideos.length;
        }
      }
    } catch (e) {
      errorLog('Add to WL failed:', e);
    }
  }

  // Exit visual mode after adding
  visualModeStart = null;
  visualBlockMode = false;
  selectedIndices.clear();
  updateMode();

  renderVideos();
  showToast(`Added ${added} video(s) to Watch Later`, added > 0 ? 'success' : 'error');
  setStatus('Ready');
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
  const query = searchQuery.toLowerCase();

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

  filteredVideos = query
    ? videos.filter(v =>
        baseFilter(v) &&
        (v.title.toLowerCase().includes(query) ||
        v.channel.toLowerCase().includes(query))
      )
    : videos.filter(baseFilter);

  videoList.innerHTML = filteredVideos.map((video, index) => {
    const inWL = currentTab === 'subscriptions' && isInWatchLater(video.id);
    const progress = getWatchedProgress(video);
    const fullyWatched = progress >= 100;
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
        <span class="video-duration">${video.duration || '--:--'}</span>
      </div>
    </div>
  `;
  }).join('');

  videoCountLabelEl.textContent = 'Videos:';
  videoCountEl.textContent = videos.length;
  selectedCountEl.textContent = selectedIndices.size;

  // Add click handlers
  videoList.querySelectorAll('.video-item').forEach(el => {
    el.addEventListener('click', (e) => {
      const index = parseInt(el.dataset.index);
      if (e.shiftKey && focusedIndex !== index) {
        // Range select
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
    });

    el.addEventListener('dblclick', () => {
      const video = filteredVideos[parseInt(el.dataset.index)];
      const url = currentTab === 'watchlater'
        ? getWatchLaterVideoUrl(video)
        : `https://www.youtube.com/watch?v=${video.id}`;
      window.open(url, '_blank');
    });
  });

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

  playlistList.querySelectorAll('.playlist-item[data-playlist-id]').forEach(el => {
    el.addEventListener('click', () => {
      const playlistId = el.dataset.playlistId;
      moveToPlaylist(playlistId);
    });
  });
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

  modalPlaylists.querySelectorAll('.modal-playlist').forEach(el => {
    el.addEventListener('click', () => {
      const playlistId = el.dataset.playlistId;
      closeModal();
      if (playlistId === 'WL') {
        addToWatchLater();
      } else if (currentTab === 'subscriptions') {
        addToPlaylist(playlistId);
      } else {
        moveToPlaylist(playlistId);
      }
    });
  });

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
  const query = searchQuery.toLowerCase();
  filteredChannels = query
    ? channels.filter(c => c.name.toLowerCase().includes(query))
    : [...channels];

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

  // Add click handlers for channels
  videoList.querySelectorAll('.channel-item').forEach(el => {
    el.addEventListener('click', () => {
      const index = parseInt(el.dataset.index);
      focusedIndex = index;
      renderChannels();
    });

    el.addEventListener('dblclick', () => {
      const channel = filteredChannels[parseInt(el.dataset.index)];
      window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
    });
  });

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
function closeConfirm() {
  isConfirmOpen = false;
  confirmModal.classList.remove('visible');
  confirmCallback = null;
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

  suggestionsList.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('click', () => {
      const channel = channelSuggestions[parseInt(el.dataset.index)];
      window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
    });
  });

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
      case 'move_to_bottom': {
        // Restore local state
        videos = lastAction.originalVideos;
        focusedIndex = lastAction.originalFocusedIndex;
        selectedIndices = lastAction.originalSelectedIndices;
        renderVideos();
        showToast('Position restored (refresh to sync with YouTube)', 'success');
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
  Promise.all(
    targets.map(video =>
      sendMessage({
        type: 'REMOVE_FROM_WATCH_LATER',
        videoId: video.id,
        setVideoId: video.setVideoId,
      }).catch(e => {
        errorLog('Delete exception:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results
      .filter(r => !r.success && r.error)
      .map(r => r.error);
    // Note: YouTube often returns 409 errors but still processes requests successfully
    if (errors.length > 0 && !errors.every(e => e.includes('409'))) {
      warnLog('Delete had non-409 errors:', errors);
      showToast(`Deleted with ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Deleted ${targets.length} video(s)`, 'success');
    }
    setStatus('Ready');
  });
}

/**
 * Delete videos from the currently active playlist (Level 2 view).
 * Optimistically updates UI then processes API calls in background.
 */
async function deleteFromPlaylist() {
  if (!activePlaylistId) return;

  const targets = getTargetVideos();
  if (targets.length === 0) return;

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
  Promise.all(
    targets.map(video =>
      sendMessage({
        type: 'REMOVE_FROM_PLAYLIST',
        videoId: video.id,
        setVideoId: video.setVideoId,
        playlistId: activePlaylistId,
      }).catch(e => {
        errorLog('Remove from playlist error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results
      .filter(r => !r.success && r.error)
      .map(r => r.error);
    if (errors.length > 0 && !errors.every(e => e.includes('409'))) {
      warnLog('Remove from playlist had errors:', errors);
      showToast(`Removed with ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Removed ${targets.length} video(s) from playlist`, 'success');
    }
    setStatus('Ready');
  });
}

async function createNewPlaylist() {
  const title = prompt('New playlist name:');
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

  const confirmed = confirm(`Delete playlist "${playlist.title}"? This cannot be undone.`);
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

  const removedVideos = [];
  let removed = 0;

  for (const video of watchedVideos) {
    try {
      const result = await sendMessage({
        type: 'REMOVE_FROM_WATCH_LATER',
        videoId: video.id,
        setVideoId: video.setVideoId,
      });
      if (result.success) {
        removed++;
        removedVideos.push(video);
      }
    } catch (err) {
      errorLog('Failed to remove video:', video.id, err);
    }
  }

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

  Promise.all(
    [...targets].reverse().map(video =>
      sendMessage({
        type: 'MOVE_TO_TOP',
        setVideoId: video.setVideoId,
        firstSetVideoId: firstNonTargetVideo?.setVideoId,
      }).catch(e => {
        errorLog('Move to top error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to top had ${errors.length} error(s)`, 'warning');
    } else {
      showToast('Moved to top', 'success');
    }
    setStatus('Ready');
  });
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

  Promise.all(
    targets.map(video =>
      sendMessage({
        type: 'MOVE_TO_BOTTOM',
        setVideoId: video.setVideoId,
        lastSetVideoId: lastNonTargetVideo?.setVideoId,
      }).catch(e => {
        errorLog('Move to bottom error:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move to bottom had ${errors.length} error(s)`, 'warning');
    } else {
      showToast('Moved to bottom', 'success');
    }
    setStatus('Ready');
  });
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
  Promise.all(
    targets.map(video =>
      sendMessage({
        type: 'MOVE_TO_PLAYLIST',
        videoId: video.id,
        setVideoId: video.setVideoId,
        playlistId,
      }).catch(e => {
        errorLog('Move failed:', e);
        return { success: false, error: String(e) };
      })
    )
  ).then(results => {
    const errors = results.filter(r => r && !r.success && r.error);
    if (errors.length > 0) {
      showToast(`Move had ${errors.length} error(s)`, 'warning');
    } else {
      showToast(`Moved ${targets.length} to ${playlist?.title}`, 'success');
    }
    setStatus('Ready');
  });
}

// Add to playlist (for subscriptions - doesn't remove from current view)
async function addToPlaylist(playlistId) {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  const playlist = getPlaylistById(playlistId);
  setStatus(`Adding ${targets.length} video(s) to ${playlist?.title}...`);

  let added = 0;
  for (const video of targets) {
    try {
      const result = await sendMessage({
        type: 'ADD_TO_PLAYLIST',
        videoId: video.id,
        playlistId,
      });
      if (result.success) {
        added++;
      }
    } catch (e) {
      errorLog('Add to playlist failed:', e);
    }
  }

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

  if (currentTab === 'watchlater') {
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
      closeConfirm();
    } else if (e.key === 'Enter' || e.key === 'y') {
      closeConfirm();
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
    if (currentTab === 'channels') return;
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
    // Visual Line mode (not for channels) - range selection with j/k
    if (currentTab === 'channels') return;
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
    // Toggle watched status (video tabs only)
    if (currentTab !== 'channels') {
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
  } else if (e.key === 'x' || e.key === 'd' || e.key === 'Delete' || e.key === 'Backspace') {
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
    }
  } else if (e.key === 'b') {
    if (currentTab === 'watchlater') {
      moveToBottom();
    }
  } else if (e.key === 'm') {
    if (currentTab === 'watchlater' || currentTab === 'subscriptions') {
      openModal();
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
  } else if (e.key === 'r') {
    loadData();
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
    } else if (currentTab === 'channels') {
      undoChannelUnsubscribe();
    }
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (currentTab === 'watchlater') {
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

  const loadingLabel = currentTab === 'watchlater' ? 'Watch Later' : 'Subscriptions';
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
    } else {
      // Load Subscriptions
      const subsResult = await sendMessage({ type: 'GET_SUBSCRIPTIONS' });

      if (subsResult.success) {
        subscriptionVideos = subsResult.data;
        subscriptionsContinuationExhausted = false;
        setLoadMoreState('hidden');
        videos = subscriptionVideos;
        subscriptionsCountEl.textContent = subscriptionVideos.length;
        renderVideos();
      } else {
        throw new Error(subsResult.error || 'Failed to load subscriptions');
      }
    }

    setStatus('Ready');
    showToast(`Loaded ${videos.length} videos`, 'success');
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
  loadingText.textContent = 'Loading...';
  setStatus('Loading...', 'loading');

  try {
    // Load quick move assignments and all data in parallel
    const [wlResult, subsResult, playlistsResult, channelsResult] = await Promise.all([
      sendMessage({ type: 'GET_WATCH_LATER' }),
      sendMessage({ type: 'GET_SUBSCRIPTIONS' }),
      sendMessage({ type: 'GET_PLAYLISTS' }),
      sendMessage({ type: 'GET_CHANNELS' }),
      loadQuickMoveAssignments(),
      loadHiddenVideos(),
      loadHideWatchLaterPref(),
      loadWatchedOverrides(),
      loadHideWatchedPref(),
    ]);

    if (wlResult.success) {
      watchLaterVideos = wlResult.data;
      watchLaterCountEl.textContent = watchLaterVideos.length;
    }

    if (subsResult.success) {
      subscriptionVideos = subsResult.data;
      subscriptionsContinuationExhausted = false;
      setLoadMoreState('hidden');
      subscriptionsCountEl.textContent = subscriptionVideos.length;
    }

    if (playlistsResult.success) {
      playlists = playlistsResult.data;
      rebuildPlaylistMap();
      playlistsCountEl.textContent = playlists.length;
      renderPlaylists();
    }

    if (channelsResult.success) {
      channels = channelsResult.data;
      rebuildChannelMap();
      channelsCountEl.textContent = channels.length;
    }

    // Derive channel activity from subscription videos
    if (subsResult.success && channelsResult.success) {
      const activityMap = deriveChannelActivity(subscriptionVideos);
      applyChannelActivity(channels, activityMap);
    }

    updateHideWatchedIndicator();

    // Set current tab's data
    if (currentTab === 'channels') {
      renderChannels();
    } else if (currentTab === 'playlists') {
      renderPlaylistBrowser();
    } else {
      videos = currentTab === 'watchlater' ? watchLaterVideos : subscriptionVideos;
      renderVideos();
    }

    // Prune stale watched overrides only if both data sources loaded
    if (watchLaterVideos.length > 0 || subscriptionVideos.length > 0) {
      const allLoadedIds = new Set([...watchLaterVideos, ...subscriptionVideos].map(v => v.id));
      await pruneStaleOverrides(allLoadedIds);
    }

    setStatus('Ready');
    showToast(`Loaded ${watchLaterVideos.length} WL, ${subscriptionVideos.length} Subs, ${channels.length} Channels`, 'success');
  } catch (error) {
    errorLog('Load error:', error);
    setStatus(error.message, 'error');
    showLoadError(error.message);
  } finally {
    loadingEl.style.display = 'none';
  }
}

// Tab click handlers
tabWatchLater.addEventListener('click', () => switchTab('watchlater'));
tabSubscriptions.addEventListener('click', () => switchTab('subscriptions'));
tabChannels.addEventListener('click', () => switchTab('channels'));
tabPlaylists.addEventListener('click', () => switchTab('playlists'));

// Breadcrumb click to return to playlist list
breadcrumbEl?.querySelector('.breadcrumb-root')?.addEventListener('click', () => {
  if (currentTab === 'playlists' && playlistBrowserLevel === 'videos') {
    drillOutOfPlaylist();
  }
});

// Confirm modal button handlers
confirmCancel.addEventListener('click', () => closeConfirm());
confirmOk.addEventListener('click', () => {
  closeConfirm();
  if (confirmCallback) confirmCallback();
});

// Infinite scroll for subscriptions and channels
const videoListContainerEl = document.getElementById('video-list-container');
let scrollDebounceTimer = null;

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
  const searchInput = document.getElementById('search-input');
  // Only restore focus if search isn't active
  if (document.activeElement !== searchInput) {
    document.body.focus();
  }
}

window.addEventListener('focus', restoreFocus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Small delay to let the browser settle
    setTimeout(restoreFocus, 50);
  }
});

// Also restore focus on any click in the app
document.querySelector('.app')?.addEventListener('click', (e) => {
  // Don't interfere with search input or buttons
  if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    restoreFocus();
  }
});

// Initialize
renderShortcuts();
loadAllData();
