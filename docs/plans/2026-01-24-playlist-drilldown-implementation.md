# Playlist Drill-Down & CRUD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Playlists tab with two-level drill-down navigation (list of playlists -> videos in a playlist), playlist CRUD operations, and `x` as canonical delete key.

**Architecture:** The Playlists tab uses a state machine with two levels. Level 1 renders the playlist list using a new `renderPlaylistBrowser()` function. Level 2 reuses the existing `renderVideos()` by setting `videos` to the loaded playlist's videos. A new `GET_PLAYLIST_VIDEOS` message type fetches videos from any playlist using the same browse endpoint pattern as Watch Later.

**Tech Stack:** TypeScript (content.ts, types.ts), Vanilla JS (dashboard.js), Chrome Extension APIs, YouTube InnerTube API.

**Note on XSS:** This codebase uses `escapeHtml()` for all dynamic text rendered via template strings. All video/playlist data comes from YouTube's authenticated InnerTube API, not user input. The existing rendering pattern is maintained throughout.

---

### Task 1: Add Playlist API Functions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/content.ts`

**Step 1: Add message types to types.ts**

Add to the MessageType union (before the PING type):

```typescript
  | { type: 'GET_PLAYLIST_VIDEOS'; playlistId: string }
  | { type: 'REMOVE_FROM_PLAYLIST'; videoId: string; setVideoId: string; playlistId: string }
  | { type: 'CREATE_PLAYLIST'; title: string }
  | { type: 'DELETE_PLAYLIST'; playlistId: string }
```

**Step 2: Add getPlaylistVideos function to content.ts**

After the `getWatchLater()` function (around line 234), add a function that fetches videos from any playlist using `browseId: 'VL' + playlistId`. It follows the exact same pattern as `getWatchLater()` — parse `playlistVideoRenderer` items and follow continuations.

**Step 3: Add removeFromPlaylist function to content.ts**

Same as `removeFromWatchLater` but with a dynamic `playlistId` parameter instead of hardcoded `'WL'`.

**Step 4: Add createPlaylist function to content.ts**

Uses `innertubeRequest('playlist/create', { title })`. Returns `{ success, playlistId }`.

**Step 5: Add deletePlaylist function to content.ts**

Uses `innertubeRequest('playlist/delete', { playlistId })`. Returns `{ success }`.

**Step 6: Add message handlers in content.ts switch statement**

Handle `GET_PLAYLIST_VIDEOS`, `REMOVE_FROM_PLAYLIST`, `CREATE_PLAYLIST`, `DELETE_PLAYLIST`.

**Step 7: Commit**

```bash
git add src/types.ts src/content.ts
git commit -m "feat(playlists): add API for playlist videos, remove, create, delete"
```

---

### Task 2: Add Playlists Tab to Navigation

**Files:**
- Modify: `src/dashboard.html`
- Modify: `src/dashboard.js`

**Step 1: Add Playlists tab button in HTML nav** (after Channels button)

**Step 2: Add breadcrumb container** above the search container in the video list wrapper

**Step 3: Add breadcrumb CSS** (root text muted, separator with >, current text primary)

**Step 4: Add DOM references** (`tabPlaylists`, `playlistsCountEl`, `breadcrumbEl`, `breadcrumbNameEl`)

**Step 5: Add playlists tab state variables** (`playlistBrowserLevel = 'list'`, `activePlaylistId`, `activePlaylistTitle`, `playlistVideos = []`)

**Step 6: Update tab cycle** (`getNextTab`/`getPrevTab` to include playlists after channels)

**Step 7: Update switchTab** (add `tabPlaylists` toggle, handle playlists case to call `renderPlaylistBrowser()`)

**Step 8: Update playlist count** after playlists load in `loadAllData`

**Step 9: Commit**

```bash
git add src/dashboard.html src/dashboard.js
git commit -m "feat(playlists): add Playlists tab with breadcrumb navigation"
```

---

### Task 3: Playlist Browser Rendering (Level 1)

**Files:**
- Modify: `src/dashboard.js`
- Modify: `src/dashboard.html` (playlist browser item CSS)

**Step 1: Add playlist browser item CSS** (grid layout: thumbnail, title/count)

**Step 2: Implement `renderPlaylistBrowser()`** — renders playlist list with search filtering, click handlers for drill-in, focus highlight

**Step 3: Implement `drillIntoPlaylist(playlist)`** — sets `activePlaylistId`, shows breadcrumb, loads videos via `GET_PLAYLIST_VIDEOS`, sets `videos = playlistVideos`, renders

**Step 4: Implement `drillOutOfPlaylist()`** — resets state, hides breadcrumb, renders playlist list

**Step 5: Commit**

```bash
git add src/dashboard.html src/dashboard.js
git commit -m "feat(playlists): implement playlist browser with drill-down"
```

---

### Task 4: Keyboard Navigation for Playlists

**Files:**
- Modify: `src/dashboard.js`

**Step 1: Handle Enter for drill-in** (when in playlists tab, Level 1)

**Step 2: Handle ESC for drill-out** (when in playlists tab, Level 2 — takes priority over clear-search)

**Step 3: Update j/k bounds** for Level 1 (use filtered playlists length instead of filteredVideos)

**Step 4: Create `renderCurrentView()` helper** and use it in j/k/gg/G/page-up/page-down handlers

**Step 5: Handle x/d for delete from playlist** (Level 2 calls `deleteFromPlaylist()`)

**Step 6: Implement `deleteFromPlaylist()`** — removes selected videos from playlist via API, updates local state

**Step 7: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(playlists): add keyboard navigation and delete for playlist drill-down"
```

---

### Task 5: Playlist CRUD (Level 1 Operations)

**Files:**
- Modify: `src/dashboard.js`

**Step 1: Handle `n` key for create** (playlists tab, Level 1 only) — prompts for name, creates via API

**Step 2: Handle `x` key for delete playlist** (playlists tab, Level 1) — confirms, deletes via API

**Step 3: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(playlists): add n to create and x to delete playlists"
```

---

### Task 6: Update Help Shortcuts

**Files:**
- Modify: `src/dashboard.js`

**Step 1: Add `playlists` category to `renderShortcuts`** with entries for Enter, Esc, x/d, n, w, H, j/k, gg/G, /, r, Tab, ?

**Step 2: Commit**

```bash
git add src/dashboard.js
git commit -m "docs(shortcuts): add playlists tab keyboard shortcuts"
```

---

### Task 7: Build & Verify

```bash
npm run typecheck && npm run build && npm test
```
