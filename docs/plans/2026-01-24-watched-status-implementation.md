# Watched Status & Hide Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add progress bar watched indicators, `w` to toggle watched, `H` to hide watched, and `W` for bulk purge.

**Architecture:** Watched state is layered: YouTube's `progressPercent` (already parsed) is the baseline, with local overrides stored in `chrome.storage.local`. A global `hideWatched` toggle filters fully-watched videos from all lists. Bulk purge (`W`) shows a confirmation dialog before deleting watched videos via the YouTube API.

**Tech Stack:** Vanilla JS (dashboard.js), Chrome Extension APIs (storage.local), CSS progress bars.

**Note on XSS:** This codebase uses `innerHTML` with template strings for rendering. All user-visible text is already escaped via the existing `escapeHtml()` utility. Video data comes from YouTube's authenticated API (not user input), so injection risk is minimal. The existing pattern is maintained throughout this plan.

---

## Key Conflict: `w` Key Reassignment

The `w` key currently means "Add to Watch Later" in subscriptions tab (`dashboard.js:2493-2497`). Since `w` will now globally mean "mark as watched", the "Add to Watch Later" action moves to the playlist modal (`m` key) — Watch Later will appear as the first option in the playlist picker.

---

### Task 1: Storage Layer for Watched Overrides

**Files:**
- Modify: `src/dashboard.js:100-158` (state declarations)
- Modify: `src/dashboard.js:444-492` (storage functions section)

**Step 1: Add state variables**

After line 155 (`let hideWatchLaterInSubs = true;`), add:

```javascript
// Watched status overrides (user-set, persisted)
let watchedOverrides = {};

// Global hide-watched toggle (persisted)
let hideWatched = false;
```

**Step 2: Add load/save functions**

After the `saveHideWatchLaterPref` function (line 492), add:

```javascript
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
```

**Step 3: Add helper to resolve watched state**

```javascript
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
```

**Step 4: Wire into initialization**

Find the `loadData()` or init section that calls `loadQuickMoveAssignments()`, `loadHiddenVideos()`, `loadHideWatchLaterPref()`. Add calls to `loadWatchedOverrides()` and `loadHideWatchedPref()` alongside them.

**Step 5: Add stale override cleanup**

```javascript
function pruneStaleOverrides(loadedVideoIds) {
  const now = Date.now();
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  let changed = false;
  const pruned = { ...watchedOverrides };
  for (const videoId of Object.keys(pruned)) {
    if (!loadedVideoIds.has(videoId) && (now - pruned[videoId].timestamp) > ninetyDays) {
      delete pruned[videoId];
      changed = true;
    }
  }
  if (changed) {
    watchedOverrides = pruned;
    saveWatchedOverrides();
  }
}
```

Call `pruneStaleOverrides(new Set(videos.map(v => v.id)))` after initial data load completes.

**Step 6: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(watched): add storage layer for watched overrides and hide toggle"
```

---

### Task 2: Progress Bar CSS

**Files:**
- Modify: `src/dashboard.html` (CSS section)

**Step 1: Remove old watched indicator styles**

Remove these CSS blocks:
- `.watched-overlay` and `.watched-overlay span` (lines 289-305)
- `.video-item.watched .video-title, .video-item.watched .video-channel` (lines 308-311)
- `.badge-watched` (lines 314-324)

**Step 2: Add progress bar styles**

Replace with:

```css
/* Progress bar (watched indicator) */
.video-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: var(--accent);
  border-radius: 0 0 4px 4px;
  transition: width 0.2s;
}

.video-item.fully-watched .video-title,
.video-item.fully-watched .video-channel {
  opacity: 0.6;
}
```

**Step 3: Add hide-watched indicator styles**

```css
/* Hide watched indicator in stats bar */
.hide-watched-indicator {
  color: var(--warning);
  font-size: 11px;
  font-weight: 600;
  display: none;
}

.hide-watched-indicator.active {
  display: inline;
}
```

**Step 4: Commit**

```bash
git add src/dashboard.html
git commit -m "feat(watched): replace watched badges with progress bar CSS"
```

---

### Task 3: Progress Bar Rendering

**Files:**
- Modify: `src/dashboard.js:833-876` (renderVideos function)

**Step 1: Update the video template in renderVideos**

Replace the `filteredVideos.map` body (lines 853-876) with updated template that uses `getWatchedProgress()` and renders a progress bar div inside `.thumbnail-wrapper`:

- Remove `isWatched` variable, replace with `progress = getWatchedProgress(video)` and `fullyWatched = progress >= 100`
- Replace class `watched` with `fully-watched`
- Remove `watched-overlay` div from thumbnail
- Add `<div class="video-progress" style="width: ${progress}%"></div>` inside `.thumbnail-wrapper` (only when progress > 0)
- Remove `badge-watched` span from `.video-meta`

**Step 2: Update renderVideos filter to respect hideWatched**

In the filter section (lines 836-851), add the hideWatched filter after the hiddenVideoIds filter and before the hideWatchLaterInSubs filter:

```javascript
  // Hide fully-watched videos when toggle is active
  if (hideWatched) {
    const origFilter = baseFilter;
    baseFilter = v => origFilter(v) && !isFullyWatched(v);
  }
```

**Step 3: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(watched): render progress bars and filter hidden watched videos"
```

---

### Task 4: Hide-Watched Indicator in Header

**Files:**
- Modify: `src/dashboard.html` (HTML body, stats section)
- Modify: `src/dashboard.js` (DOM references, indicator update)

**Step 1: Add indicator element to header stats**

After the "Selected" stat div (line 1373), add:

```html
        <div class="stat">
          <span class="hide-watched-indicator" id="hide-watched-indicator">Hiding watched</span>
        </div>
```

**Step 2: Add DOM reference in dashboard.js**

Near line 248 (after other DOM element declarations), add:

```javascript
const hideWatchedIndicatorEl = document.getElementById('hide-watched-indicator');
```

**Step 3: Add indicator update function**

```javascript
function updateHideWatchedIndicator() {
  if (hideWatchedIndicatorEl) {
    hideWatchedIndicatorEl.classList.toggle('active', hideWatched);
  }
}
```

Call `updateHideWatchedIndicator()` after loading the preference and after toggling.

**Step 4: Commit**

```bash
git add src/dashboard.html src/dashboard.js
git commit -m "feat(watched): add hide-watched indicator in header"
```

---

### Task 5: `w` Key — Toggle Watched

**Files:**
- Modify: `src/dashboard.js:2493-2497` (current `w` key handler)

**Step 1: Replace the `w` key handler**

Replace the current handler:

```javascript
  } else if (e.key === 'w') {
    // Add to Watch Later (subscriptions tab only)
    if (currentTab === 'subscriptions') {
      addToWatchLater();
    }
  }
```

With:

```javascript
  } else if (e.key === 'w' && !e.shiftKey) {
    // Toggle watched status
    toggleWatched();
  }
```

**Step 2: Implement toggleWatched**

```javascript
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
```

**Step 3: Move "Add to Watch Later" into playlist modal**

In the modal rendering logic, ensure Watch Later appears as the first option when the user presses `m` in subscriptions tab. Find where playlists are rendered in the modal and prepend a Watch Later entry:

```javascript
const watchLaterOption = { id: 'WL', title: 'Watch Later' };
const modalItems = currentTab === 'subscriptions'
  ? [watchLaterOption, ...playlists]
  : playlists;
```

When user selects the `WL` item, call `addToWatchLater()` instead of `moveToPlaylist()`.

**Step 4: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(watched): add w key for toggle watched, move add-to-WL to modal"
```

---

### Task 6: `H` Key — Toggle Hide Watched

**Files:**
- Modify: `src/dashboard.js` (keyboard handler section)

**Step 1: Add `H` key handler**

In the keyboard handler, add after the `w` handler:

```javascript
  } else if (e.key === 'H') {
    toggleHideWatched();
  }
```

**Step 2: Implement toggleHideWatched**

```javascript
function toggleHideWatched() {
  hideWatched = !hideWatched;
  saveHideWatchedPref();
  updateHideWatchedIndicator();
  renderVideos();
  const state = hideWatched ? 'Hiding' : 'Showing';
  showToast(`${state} watched videos`, 'success');
}
```

**Step 3: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(watched): add H key to toggle hide-watched filter"
```

---

### Task 7: `W` Key — Bulk Purge Dialog

**Files:**
- Modify: `src/dashboard.html` (add purge modal HTML + CSS)
- Modify: `src/dashboard.js` (keyboard handler, purge logic)

**Step 1: Add purge modal HTML**

After the existing confirm-modal div in the HTML, add a new modal overlay with:
- A header showing "Remove Watched Videos" and a count
- A scrollable list of watched videos (title, channel, progress %)
- Confirm and Cancel buttons

**Step 2: Add purge modal CSS**

Style the modal with max-width 600px, max-height 70vh, scrollable list, grid layout for items showing title/channel on left and progress % on right.

**Step 3: Add `W` key handler**

```javascript
  } else if (e.key === 'W') {
    if (currentTab === 'watchlater') {
      openPurgeDialog();
    } else {
      showToast('Bulk purge only available in Watch Later', 'info');
    }
  }
```

**Step 4: Implement openPurgeDialog**

- Collect all `filteredVideos.filter(v => isFullyWatched(v))`
- If none, show toast and return
- Render list into purge modal with title, channel, progress for each
- Show modal
- Listen for Enter (confirm) or Escape (cancel)
- On confirm, call `executePurge(watchedVideos)`

**Step 5: Implement executePurge**

- Loop through watched videos, call `REMOVE_FROM_WATCH_LATER` for each
- Remove from local `videos` and `watchLaterVideos` arrays
- Push single undo stack entry with all removed videos
- Clamp `focusedIndex`, clear selection
- Re-render and show success toast

**Step 6: Commit**

```bash
git add src/dashboard.html src/dashboard.js
git commit -m "feat(watched): add W key for bulk purge with confirmation dialog"
```

---

### Task 8: Update Help Modal Shortcuts

**Files:**
- Modify: `src/dashboard.js` (shortcuts list rendering)

**Step 1: Update shortcuts entries**

Find the shortcuts rendering and:
- Remove old `w` = "Add to Watch Later" entry
- Add: `w` = "Toggle watched", `H` = "Toggle hide watched", `W` = "Purge watched videos"

**Step 2: Commit**

```bash
git add src/dashboard.js
git commit -m "docs(shortcuts): update help with watched status keys"
```

---

### Task 9: Build & Verify

**Step 1: Build**

```bash
npm run build
```

Verify no build errors.

**Step 2: Run tests**

```bash
npm test
```

Verify existing tests still pass.

**Step 3: Manual test checklist**

- Load extension in Chrome
- Verify progress bars appear on videos with `progressPercent > 0`
- Press `w` on a video — full red progress bar appears
- Press `w` again — progress bar removed (or falls back to YouTube data)
- Press `H` — "Hiding watched" indicator appears, fully-watched videos disappear
- Press `H` again — videos reappear
- Press `W` — purge dialog shows fully-watched videos with title/channel/progress
- Cancel purge — nothing changes
- Confirm purge — videos removed, undo available
- Reload extension — `hideWatched` and `watchedOverrides` persist
- Press `m` in subscriptions — Watch Later appears as first playlist option
