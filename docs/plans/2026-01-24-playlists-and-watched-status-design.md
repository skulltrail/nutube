# Playlist Management & Watched Status Design

## Summary

Expand NuTube beyond Watch Later and Subscriptions to full playlist management with a drill-down navigation model, and add watched status indicators with a global hide toggle.

---

## Feature 1: Watched Status Indicators

### Data Sources

1. **YouTube's progress data** — `progressPercent` already parsed from InnerTube API responses.
2. **Local overrides** — User marks videos watched/unwatched via `w`. Stored in `chrome.storage.local` keyed by video ID. Persists across sessions and extension updates.

**Precedence:** Local override wins. Toggling off a local override falls back to YouTube's data.

### Visual Indicator

- Red progress bar beneath each video row (matching YouTube's style).
- Partially watched: bar fills proportionally.
- Fully watched (100% or manually marked): full red bar.
- Unwatched: no bar.

### Keyboard

- `w` — Toggle watched/unwatched on focused video or visual selection.

---

## Feature 2: Hide Watched Toggle

- `H` — Global toggle, applies to all tabs.
- Persisted in `chrome.storage.local`.
- When enabled: videos at 100% progress (YouTube data or local override) are filtered out.
- Partially watched videos remain visible.
- **UI indicator:** Badge/label in header area (e.g., "Hiding watched" or eye-slash icon) visible when active.

---

## Feature 3: Bulk Purge

- `W` — Shows confirmation dialog listing all watched videos in the current tab/playlist.
- Each entry shows: title, channel, progress percentage.
- **Confirm:** Deletes all listed videos from the playlist via YouTube API. Single undo stack entry.
- **Decline:** Dialog closes. User fixes marks with `w` and retries.

---

## Feature 4: Playlist Drill-Down

### Navigation Model

- **Level 1:** List of all user playlists (name, video count, thumbnail). Vim navigation applies (`j`/`k`, `gg`/`G`, `/` search).
- **Level 2:** `Enter` drills into a playlist. Full vim video navigation. `ESC` returns to Level 1.
- **Breadcrumb:** `Playlists > Playlist Name` above the video list.
- **Tab header:** Stays as "Playlists" at all times.

### Operations at Level 1 (playlist list)

- `Enter` — drill into playlist
- `n` — create new playlist (prompts for name)
- `r` — rename selected playlist
- `x` — delete entire playlist (with confirmation)

### Operations at Level 2 (inside a playlist)

- Same as Watch Later: `d`/`x` delete, `m` move, `y` yank, visual selection
- `ESC` — back to playlist list

### Delete Key

- `x` is the canonical delete key. `d` remains as an alias.

---

## Storage Schema

```javascript
{
  // Watched status overrides (user-set)
  "watchedOverrides": {
    "videoId123": { "watched": true, "timestamp": 1706000000 },
    "videoId456": { "watched": false, "timestamp": 1706000100 }
  },

  // Global hide-watched toggle
  "hideWatched": true,

  // Cached playlist list (for faster Level 1 load)
  "playlistCache": { ... }
}
```

**Cleanup:** Entries in `watchedOverrides` older than 90 days with no matching video in any loaded playlist are pruned on extension load.

---

## API Changes (content.ts / types.ts)

New message types:

| Message | Purpose |
|---------|---------|
| `GET_PLAYLIST_VIDEOS` | Fetch videos for a specific playlist ID |
| `CREATE_PLAYLIST` | Create playlist with name |
| `RENAME_PLAYLIST` | Rename a playlist |
| `DELETE_PLAYLIST` | Delete entire playlist |
| `REMOVE_FROM_PLAYLIST` | Remove video(s) from a specific playlist |
| `ADD_TO_PLAYLIST` | Add video(s) to a playlist |
| `REORDER_IN_PLAYLIST` | Move video position within a playlist |

Parsing reuses existing `playlistVideoRenderer` / `lockupViewModel` parsers. No new permissions required.

---

## Implementation Phases

### Phase 1: Watched status indicators
- Progress bar rendering on video rows across all tabs
- `watchedOverrides` storage with `w` keybinding
- `H` toggle with persistence and UI indicator

### Phase 2: Bulk purge (`W`)
- Confirmation dialog UI
- Batch delete via API
- Undo stack integration

### Phase 3: Playlist drill-down
- Two-level Playlists tab view
- `Enter`/`ESC` navigation
- Breadcrumb rendering
- Reuse video list rendering at Level 2

### Phase 4: Playlist CRUD
- `n` create, `r` rename, `x` delete at Level 1
- New message types and API handlers in `content.ts`
- `x` delete from playlist at Level 2

### Phase 5: `x` as canonical delete
- Add `x` as delete across all tabs
- Keep `d` as alias
