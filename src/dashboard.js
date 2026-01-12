// State
let videos = [];
let filteredVideos = [];
let playlists = [];
let selectedIndices = new Set();
let focusedIndex = 0;
let visualModeStart = null;
let searchQuery = '';
let modalFocusedIndex = 0;
let isModalOpen = false;
let isHelpOpen = false;
let pendingG = false;

// Tab state
let currentTab = 'watchlater'; // 'watchlater', 'subscriptions', or 'channels'
let watchLaterVideos = [];
let subscriptionVideos = [];
let channels = [];
let filteredChannels = [];
let isLoadingMore = false; // For infinite scroll
let subscriptionsContinuationExhausted = false;
let lastLoadTime = 0;
const LOAD_DEBOUNCE_MS = 500;

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

// Channel undo stack (separate from videos)
const channelUndoStack = [];
const MAX_CHANNEL_UNDO = 50;

// Quick move assignments: { 1: "playlistId", 2: "playlistId", ... }
let quickMoveAssignments = {};

// Undo history
const undoStack = [];
const MAX_UNDO = 50;

// DOM elements
const videoList = document.getElementById('video-list');
const playlistList = document.getElementById('playlist-list');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const videoCountEl = document.getElementById('video-count');
const videoCountLabelEl = document.getElementById('video-count-label');
const selectedCountEl = document.getElementById('selected-count');
const statusMessage = document.getElementById('status-message');
const searchInput = document.getElementById('search-input');
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
const suggestionsTitle = document.getElementById('suggestions-title');
const confirmModal = document.getElementById('confirm-modal');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmOk = document.getElementById('confirm-ok');
const shortcutsList = document.getElementById('shortcuts-list');
const subscriptionsLoadingEl = document.getElementById('subscriptions-loading');
const loadMoreIndicatorEl = document.getElementById('load-more-indicator');

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
          { keys: ['u'], desc: 'Undo' },
        ]
      },
      {
        title: 'Selection',
        shortcuts: [
          { keys: ['v'], desc: 'Visual mode' },
          { keys: ['Space'], desc: 'Preview' },
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
          { keys: ['Tab'], desc: 'Switch tab' },
          { keys: ['?'], desc: 'Help' },
        ]
      },
    ],
    subscriptions: [
      {
        title: 'Actions',
        shortcuts: [
          { keys: ['Space'], desc: 'Toggle Watch Later' },
          { keys: ['w'], desc: 'Add to Watch Later' },
          { keys: ['m'], desc: 'Add to playlist' },
          { keys: ['1-9'], desc: 'Quick add' },
        ]
      },
      {
        title: 'Selection',
        shortcuts: [
          { keys: ['v'], desc: 'Visual mode' },
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
          { keys: ['↵'], desc: 'Watch video' },
          { keys: ['q'], desc: 'Close' },
        ]
      },
      {
        title: 'Other',
        shortcuts: [
          { keys: ['o', '↵'], desc: 'Open channel' },
          { keys: ['y'], desc: 'Copy URL' },
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
    return playlists.find(p => p.id === playlistId);
  }
  return null;
}

// Toast notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Tab switching
function switchTab(tab) {
  if (tab === currentTab) return;

  currentTab = tab;
  selectedIndices.clear();
  focusedIndex = 0;
  visualModeStart = null;
  searchQuery = '';
  searchInput.value = '';

  // Update tab UI
  tabWatchLater.classList.toggle('active', tab === 'watchlater');
  tabSubscriptions.classList.toggle('active', tab === 'subscriptions');
  tabChannels.classList.toggle('active', tab === 'channels');
  renderShortcuts();

  // Switch data and render
  if (tab === 'channels') {
    renderChannels();
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

// Get next tab in cycle
function getNextTab() {
  if (currentTab === 'watchlater') return 'subscriptions';
  if (currentTab === 'subscriptions') return 'channels';
  return 'watchlater';
}

// Get previous tab in cycle (for SHIFT+TAB)
function getPrevTab() {
  if (currentTab === 'watchlater') return 'channels';
  if (currentTab === 'channels') return 'subscriptions';
  return 'watchlater';
}

// Add to Watch Later (for subscriptions tab)
async function addToWatchLater() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  setStatus(`Adding ${targets.length} video(s) to Watch Later...`);

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
      console.error('Add to WL failed:', e);
    }
  }

  selectedIndices.clear();
  renderVideos();
  showToast(`Added ${added} video(s) to Watch Later`, added > 0 ? 'success' : 'error');
  setStatus('Ready');
}

// Remove from Watch Later (for subscriptions tab - removes from WL list)
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
    console.error('Remove from WL failed:', e);
  }
  return false;
}

// Toggle Watch Later status (for subscriptions tab)
async function toggleWatchLater() {
  if (currentTab !== 'subscriptions') return;

  const video = filteredVideos[focusedIndex];
  if (!video) return;

  const inWL = isInWatchLater(video.id);

  if (inWL) {
    setStatus('Removing from Watch Later...');
    const success = await removeFromWatchLaterSub(video);
    renderVideos();
    showToast(success ? 'Removed from Watch Later' : 'Failed to remove', success ? 'success' : 'error');
  } else {
    setStatus('Adding to Watch Later...');
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
      console.error('Add to WL failed:', e);
      showToast('Failed to add', 'error');
    }
  }
  setStatus('Ready');
}

// Load more subscriptions (infinite scroll)
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
    console.log('[NuTube] loadMoreSubscriptions called, current count:', subscriptionVideos.length);
    const result = await sendMessage({ type: 'GET_MORE_SUBSCRIPTIONS' });
    console.log('[NuTube] loadMoreSubscriptions result:', result.success, 'videos:', result.data?.length || 0);

    if (result.success && result.data && result.data.length > 0) {
      // Add new videos, avoiding duplicates
      const prevCount = subscriptionVideos.length;
      for (const video of result.data) {
        if (!subscriptionVideos.find(v => v.id === video.id)) {
          subscriptionVideos.push(video);
        }
      }
      const newCount = subscriptionVideos.length - prevCount;
      console.log('[NuTube] Added', newCount, 'new videos, total:', subscriptionVideos.length);

      videos = subscriptionVideos;
      subscriptionsCountEl.textContent = subscriptionVideos.length;
      renderVideos();

      // Recalculate channel activity with new videos
      recalculateChannelActivity();

      setLoadMoreState('hidden');
    } else if (result.success && (!result.data || result.data.length === 0)) {
      console.log('[NuTube] No more videos to load (continuation exhausted)');
      subscriptionsContinuationExhausted = true;
      setLoadMoreState('exhausted');
    } else if (!result.success) {
      console.warn('[NuTube] Load more failed:', result.error);
      setLoadMoreState('error');
    }
  } catch (e) {
    console.warn('[NuTube] Load more exception:', e);
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
  filteredVideos = query
    ? videos.filter(v =>
        v.title.toLowerCase().includes(query) ||
        v.channel.toLowerCase().includes(query)
      )
    : [...videos];

  videoList.innerHTML = filteredVideos.map((video, index) => {
    const inWL = currentTab === 'subscriptions' && isInWatchLater(video.id);
    const isWatched = video.watched || (video.progressPercent && video.progressPercent >= 90);
    return `
    <div class="video-item ${selectedIndices.has(index) ? 'selected' : ''} ${focusedIndex === index ? 'focused' : ''} ${isWatched ? 'watched' : ''}"
         data-index="${index}"
         data-video-id="${video.id}">
      <span class="video-index">${index + 1}</span>
      <div class="thumbnail-wrapper">
        <img class="video-thumbnail" src="${fixUrl(video.thumbnail)}" alt="" loading="lazy">
        ${isWatched ? '<div class="watched-overlay"><span>Watched</span></div>' : ''}
      </div>
      <div class="video-info">
        <div class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
        <div class="video-channel">${escapeHtml(video.channel)}</div>
      </div>
      <div class="video-meta">
        ${inWL ? '<span class="wl-check" title="In Watch Later">✓</span>' : ''}
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
      renderVideos();
    });

    el.addEventListener('dblclick', () => {
      const video = filteredVideos[parseInt(el.dataset.index)];
      window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
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
  modalPlaylists.innerHTML = sortedPlaylists.map((playlist, index) => {
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
      if (currentTab === 'subscriptions') {
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

// Video Preview - opens directly on YouTube since embeds don't work from chrome-extension:// origin
function showVideoPreview(video) {
  window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
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
      console.error('Error fetching channel videos:', e);
      return { success: false, error: String(e) };
    }),
    sendMessage({ type: 'GET_CHANNEL_SUGGESTIONS', channelId: channel.id }).catch(e => {
      console.error('Error fetching similar channels:', e);
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
    const filteredSimilar = similarResponse.data.filter(s => !channels.find(c => c.id === s.id));
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

  // Set up new pending confirmation with 2-second timeout
  const timeoutId = setTimeout(() => {
    cancelUnsubscribeConfirm();
  }, 2000);

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

  setStatus(`Unsubscribing from ${channel.name}...`);
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
    console.error('Unsubscribe failed:', e);
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

  // Remove after 5 seconds
  setTimeout(() => toast.remove(), 5000);
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

  setStatus(`Resubscribing to ${lastAction.channel.name}...`);
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
    console.error('Resubscribe failed:', e);
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

// Show similar channels modal
async function showSimilarChannels(channel) {
  suggestionsTitle.textContent = `Similar to ${channel.name}`;
  suggestionsList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  isSuggestionsOpen = true;
  suggestionsFocusedIndex = 0;
  suggestionsModal.classList.add('visible');

  try {
    const result = await sendMessage({ type: 'GET_CHANNEL_SUGGESTIONS', channelId: channel.id });
    if (result.success && result.data.length > 0) {
      // Filter out channels we're already subscribed to
      channelSuggestions = result.data.filter(s => !channels.find(c => c.id === s.id));
      renderSuggestions();
    } else {
      suggestionsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">No similar channels found</div>';
    }
  } catch (e) {
    console.error('Get suggestions failed:', e);
    suggestionsList.innerHTML = '<div style="text-align: center; color: var(--accent); padding: 20px;">Failed to load suggestions</div>';
  }
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
        if (!channels.find(c => c.id === channel.id)) {
          channels.push(channel);
        }
      }
      channelsCountEl.textContent = channels.length;
      renderChannels();
    }
  } catch (e) {
    console.warn('Load more channels failed:', e);
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
  setStatus(`Undoing ${lastAction.action}...`);

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
            console.error('Restore failed:', e);
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
            console.error('Restore failed:', e);
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
    console.error('Undo error:', error);
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

  setStatus(`Deleting ${targets.length} video(s)...`);

  let attempted = 0;
  const errors = [];
  for (const video of targets) {
    try {
      const result = await sendMessage({
        type: 'REMOVE_FROM_WATCH_LATER',
        videoId: video.id,
        setVideoId: video.setVideoId,
      });
      attempted++;
      // Update UI optimistically - YouTube often returns errors but still processes
      videos = videos.filter(v => v.id !== video.id);
      if (!result.success && result.error) {
        errors.push(result.error);
      }
    } catch (e) {
      console.error('Delete exception:', e);
      errors.push(String(e));
    }
  }

  selectedIndices.clear();
  focusedIndex = Math.min(focusedIndex, Math.max(0, videos.length - 1));
  renderVideos();

  // Note: YouTube often returns 409 errors but still processes requests successfully
  if (errors.length > 0 && !errors.every(e => e.includes('409'))) {
    console.warn('Delete had non-409 errors:', errors);
  }
  showToast(`Deleted ${attempted} video(s)`, 'success');
  setStatus('Ready');
}

async function moveToTop() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  saveUndoState('move_to_top', { targets: [...targets] });

  setStatus(`Moving ${targets.length} video(s) to top...`);

  // Move in reverse order to maintain relative order
  for (const video of [...targets].reverse()) {
    try {
      // Get the current first video's setVideoId (to move before it)
      const firstVideo = videos.find(v => v.id !== video.id);
      await sendMessage({
        type: 'MOVE_TO_TOP',
        setVideoId: video.setVideoId,
        firstSetVideoId: firstVideo?.setVideoId,
      });
      // Update local list optimistically - YouTube often succeeds despite errors
      videos = videos.filter(v => v.id !== video.id);
      videos.unshift(video);
    } catch (e) {
      console.error('Move to top error:', e);
    }
  }

  selectedIndices.clear();
  focusedIndex = 0;
  renderVideos();
  showToast('Moved to top');
  setStatus('Ready');
}

async function moveToBottom() {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  saveUndoState('move_to_bottom', { targets: [...targets] });

  setStatus(`Moving ${targets.length} video(s) to bottom...`);

  for (const video of targets) {
    try {
      // Get the current last video's setVideoId (to move after it)
      const lastVideo = videos.filter(v => v.id !== video.id).pop();
      await sendMessage({
        type: 'MOVE_TO_BOTTOM',
        setVideoId: video.setVideoId,
        lastSetVideoId: lastVideo?.setVideoId,
      });
      // Update local list optimistically - YouTube often succeeds despite errors
      videos = videos.filter(v => v.id !== video.id);
      videos.push(video);
    } catch (e) {
      console.error('Move to bottom error:', e);
    }
  }

  selectedIndices.clear();
  focusedIndex = videos.length - 1;
  renderVideos();
  showToast('Moved to bottom');
  setStatus('Ready');
}

async function moveToPlaylist(playlistId) {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  // Save for undo
  const playlist = playlists.find(p => p.id === playlistId);
  saveUndoState('move_to_playlist', { videos: [...targets], playlistId, playlistTitle: playlist?.title });

  setStatus(`Moving ${targets.length} video(s) to ${playlist?.title}...`);

  let attempted = 0;
  for (const video of targets) {
    try {
      await sendMessage({
        type: 'MOVE_TO_PLAYLIST',
        videoId: video.id,
        setVideoId: video.setVideoId,
        playlistId,
      });
      attempted++;
      // Update UI optimistically
      videos = videos.filter(v => v.id !== video.id);
    } catch (e) {
      console.error('Move failed:', e);
    }
  }

  selectedIndices.clear();
  focusedIndex = Math.min(focusedIndex, Math.max(0, videos.length - 1));
  renderVideos();
  showToast(`Moved ${attempted} to ${playlist?.title}`, 'success');
  setStatus('Ready');
}

// Add to playlist (for subscriptions - doesn't remove from current view)
async function addToPlaylist(playlistId) {
  const targets = getTargetVideos();
  if (targets.length === 0) return;

  const playlist = playlists.find(p => p.id === playlistId);
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
      console.error('Add to playlist failed:', e);
    }
  }

  selectedIndices.clear();
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
      { keys: ['v'], desc: 'Visual mode (range select)' },
      { keys: ['Space'], desc: 'Preview video' },
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
      { keys: ['v'], desc: 'Visual mode (range select)' },
      { keys: ['Space'], desc: 'Toggle Watch Later' },
    ];
    actionsShortcuts = [
      { keys: ['w'], desc: 'Add to Watch Later' },
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

// Update visual selection
function updateVisualSelection() {
  if (visualModeStart === null) return;
  selectedIndices.clear();
  const start = Math.min(visualModeStart, focusedIndex);
  const end = Math.max(visualModeStart, focusedIndex);
  for (let i = start; i <= end; i++) {
    selectedIndices.add(i);
  }
}

// Keyboard handling
document.addEventListener('keydown', (e) => {
  // Search input handling
  if (document.activeElement === searchInput) {
    if (e.key === 'Escape') {
      searchInput.blur();
      searchInput.value = '';
      searchQuery = '';
      if (currentTab === 'channels') {
        renderChannels();
      } else {
        renderVideos();
      }
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
        scrollChannelVideos('left');
        break;
      case 'l':
      case 'ArrowRight':
        scrollChannelVideos('right');
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
      suggestionsFocusedIndex = Math.min(suggestionsFocusedIndex + 1, channelSuggestions.length - 1);
      renderSuggestions();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
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
    const sortedPlaylists = getSortedPlaylists();
    if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
      modalFocusedIndex = Math.min(modalFocusedIndex + 1, sortedPlaylists.length - 1);
      renderModalPlaylists();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      modalFocusedIndex = Math.max(modalFocusedIndex - 1, 0);
      renderModalPlaylists();
    } else if (e.key === 'Enter') {
      closeModal();
      const playlistId = sortedPlaylists[modalFocusedIndex]?.id;
      if (currentTab === 'subscriptions') {
        addToPlaylist(playlistId);
      } else {
        moveToPlaylist(playlistId);
      }
    } else if (e.key >= '1' && e.key <= '9') {
      // Assign quick move number to focused playlist
      const num = e.key;
      const focusedPlaylist = sortedPlaylists[modalFocusedIndex];
      if (focusedPlaylist) {
        assignQuickMove(num, focusedPlaylist.id);
        showToast(`Assigned ${num} to "${focusedPlaylist.title}"`, 'success');
        renderModalPlaylists();
        renderPlaylists();
      }
    } else if (e.key === '0') {
      // Clear quick move assignment from focused playlist
      const focusedPlaylist = sortedPlaylists[modalFocusedIndex];
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
      focusedIndex = 0;
      selectedIndices.clear();
      visualModeStart = null;
      if (currentTab === 'channels') {
        renderChannels();
      } else {
        renderVideos();
      }
      pendingG = false;
    } else {
      pendingG = true;
      setTimeout(() => { pendingG = false; }, 500);
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
    // Cancel pending unsubscribe confirmation
    if (pendingUnsubscribe) {
      cancelUnsubscribeConfirm();
      return;
    }

    selectedIndices.clear();
    visualModeStart = null;
    searchQuery = '';
    searchInput.value = '';
    if (currentTab === 'channels') {
      renderChannels();
    } else {
      renderVideos();
    }
  } else if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    // Cancel pending unsubscribe confirmation on navigation
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();

    const maxIndex = currentTab === 'channels' ? filteredChannels.length - 1 : filteredVideos.length - 1;
    if (visualModeStart !== null && currentTab !== 'channels') {
      focusedIndex = Math.min(focusedIndex + 1, maxIndex);
      updateVisualSelection();
    } else {
      focusedIndex = Math.min(focusedIndex + 1, maxIndex);
    }
    if (currentTab === 'channels') {
      renderChannels();
    } else {
      renderVideos();
    }
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    // Cancel pending unsubscribe confirmation on navigation
    if (pendingUnsubscribe) cancelUnsubscribeConfirm();

    if (visualModeStart !== null && currentTab !== 'channels') {
      focusedIndex = Math.max(focusedIndex - 1, 0);
      updateVisualSelection();
    } else {
      focusedIndex = Math.max(focusedIndex - 1, 0);
    }
    if (currentTab === 'channels') {
      renderChannels();
    } else {
      renderVideos();
    }
  } else if (e.key === 'G') {
    // Go to bottom
    const maxIndex = currentTab === 'channels' ? filteredChannels.length - 1 : filteredVideos.length - 1;
    focusedIndex = maxIndex;
    selectedIndices.clear();
    visualModeStart = null;
    if (currentTab === 'channels') {
      renderChannels();
    } else {
      renderVideos();
    }
  } else if (e.key === ' ') {
    e.preventDefault();
    if (currentTab === 'subscriptions') {
      // Toggle Watch Later status for focused video
      toggleWatchLater();
    } else if (currentTab === 'channels') {
      // Show similar channels for focused channel
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        showSimilarChannels(channel);
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
  } else if (e.key === 'v') {
    // Visual mode (not for channels)
    if (currentTab === 'channels') return;
    if (visualModeStart === null) {
      visualModeStart = focusedIndex;
      selectedIndices.clear();
      selectedIndices.add(focusedIndex);
    } else {
      visualModeStart = null;
    }
    renderVideos();
    setStatus(visualModeStart !== null ? 'Visual mode - use j/k to select range' : 'Ready');
  } else if (e.key === 'Tab') {
    // Cycle through tabs (SHIFT+TAB goes backwards)
    e.preventDefault();
    switchTab(e.shiftKey ? getPrevTab() : getNextTab());
  } else if (e.key === 'w') {
    // Add to Watch Later (subscriptions tab only)
    if (currentTab === 'subscriptions') {
      addToWatchLater();
    }
  } else if (e.key === 'x' || e.key === 'd' || e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (currentTab === 'watchlater') {
      deleteVideos();
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
        moveToPlaylist(playlist.id);
      } else {
        showToast(`No playlist assigned to ${e.key}. Press m to assign.`, 'info');
      }
    } else if (currentTab === 'subscriptions') {
      const playlist = getPlaylistByQuickMove(e.key);
      if (playlist) {
        addToPlaylist(playlist.id);
      } else {
        showToast(`No playlist assigned to ${e.key}. Press m to assign.`, 'info');
      }
    }
  } else if (e.key === 'Enter') {
    if (currentTab === 'channels') {
      const channel = filteredChannels[focusedIndex];
      if (channel) {
        window.open(`https://www.youtube.com/channel/${channel.id}`, '_blank');
      }
    } else {
      const video = filteredVideos[focusedIndex];
      if (video) {
        window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
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
  }
});

// Search input
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  focusedIndex = 0;
  selectedIndices.clear();
  if (currentTab === 'channels') {
    renderChannels();
  } else {
    renderVideos();
  }
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
    console.error('Load error:', error);
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
  setStatus('Loading...');

  try {
    // Load quick move assignments and all data in parallel
    const [wlResult, subsResult, playlistsResult, channelsResult] = await Promise.all([
      sendMessage({ type: 'GET_WATCH_LATER' }),
      sendMessage({ type: 'GET_SUBSCRIPTIONS' }),
      sendMessage({ type: 'GET_PLAYLISTS' }),
      sendMessage({ type: 'GET_CHANNELS' }),
      loadQuickMoveAssignments(),
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
      renderPlaylists();
    }

    if (channelsResult.success) {
      channels = channelsResult.data;
      channelsCountEl.textContent = channels.length;
    }

    // Derive channel activity from subscription videos
    if (subsResult.success && channelsResult.success) {
      const activityMap = deriveChannelActivity(subscriptionVideos);
      applyChannelActivity(channels, activityMap);
    }

    // Set current tab's data
    if (currentTab === 'channels') {
      renderChannels();
    } else {
      videos = currentTab === 'watchlater' ? watchLaterVideos : subscriptionVideos;
      renderVideos();
    }

    setStatus('Ready');
    showToast(`Loaded ${watchLaterVideos.length} WL, ${subscriptionVideos.length} Subs, ${channels.length} Channels`, 'success');
  } catch (error) {
    console.error('Load error:', error);
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
    // Load more when user scrolls within 500px of bottom (increased from 200px)
    if (distanceFromBottom < 500) {
      if (currentTab === 'subscriptions') {
        loadMoreSubscriptions();
      } else if (currentTab === 'channels') {
        loadMoreChannels();
      }
    }
  }, 100);
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
