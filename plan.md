# Implementation Plan: Bulletproof Replays & Clean Scrobbling

## 1. Executive Summary & Objectives

### Problem
In `multi-scrobbler`, listening to Spotify replays (e.g. rewinding near the end of a track, or skipping forward to the next song for a few seconds and clicking back) causes listens to either:
1. **Never get logged** (the rewind is either missed and merged into the previous play as a mere seek, or dropped in `MemorySource` by an artificial duration lock).
2. **Get flagged as `Dupe`** (the database and client deduplication algorithms search backwards by the track's entire `duration`, causing sequential replays of the same song to match each other as duplicates).

### Solution Architecture
We adopt the **Web Scrobbler / ListenBrainz model**:
1. **Scrobble Trigger (The 50% Rule)**: As soon as a track has been listened to for 50% of its duration or 4 minutes, it is marked as scrobbled and emitted immediately.
2. **Symmetric Rewind Detection**: When the player position drops backwards by an amount that satisfies the scrobble threshold (>= 50% or >= 4 minutes) after the track has already scrobbled, the current session is closed and a brand new listening session is initialized for the replay.
3. **Clean 30-Second Deduplication**: Deduplication across identical tracks only matches if timestamps fall within a narrow **±30-second window**. We eliminate duration-spanning search windows and false fuzzy matches for live sequential plays.

---

## 2. "Go Nuclear" Directive: Aggressive Cleanup of Overengineering & Dead Code

**Guideline for the implementing agent**: Do **NOT** keep defensive workarounds, obsolete fallback heuristics, or dead branches "just in case". The previous bugs in `multi-scrobbler` were directly caused by over-defensive, layered guessing. Clean it up aggressively:

1. **Delete Obsolete Repeat Heuristics**:
   - In `src/backend/utils/TimeUtils.ts`: **Delete** `closeToPlayStart`, `closeToPlayEnd`, and `repeatDurationPlayed`. They were fragile heuristics that failed with real polling intervals.
   - In `src/backend/common/infrastructure/Atomic.ts`: **Delete** unused constants:
     - `DEFAULT_CLOSE_POSITION_ABSOLUTE`
     - `DEFAULT_CLOSE_POSITION_PERCENT`
     - `DEFAULT_DURATION_REPEAT_ABSOLUTE`
     - `DEFAULT_DURATION_REPEAT_PERCENT`
   - In `src/backend/tests/utilitiesTests/time.test.ts`: Remove the tests testing these deleted functions.
2. **Rip Out the `isSessionRepeat` Maze**:
   - In `src/backend/sources/PlayerState/AbstractPlayerState.ts`: **Delete** the ~75 lines of candidate list building, context logging, and multi-condition guessing in `isSessionRepeat`. Replace with the simple, 10-line `isPositionRewind` check.
3. **Rip Out Artificial Duration Locks**:
   - In `src/backend/sources/MemorySource.ts`: **Delete** the `if (playDate.isAfter(rplayDate.add(duration, 's')))` block and its nested missing-duration fallbacks. Live plays from an active player are verified in real-time and do not need duration locking.
4. **Rip Out Duration-Spanning Search Windows for Live Plays**:
   - In `src/backend/common/database/drizzle/repositories/PlayRepository.ts`: Stop expanding `startRange = playDate - duration` when querying against live player plays. Live sequential plays are not duplicates.
5. **Code Style**: Keep functions short, clear, and readable. Prioritize simple invariants over nested defensive `if/else` ladders.

---

## 3. Core Architecture & Workflow

### 3.1 Live Player Lifecycle (`AbstractPlayerState`)

```
T = 0:00               T = 1:30 (50%)                    T = 2:40 (Rewind)
   │                          │                                 │
   ▼                          ▼                                 ▼
Track Starts           Threshold Met!                    Position drops to 0:05
• playFirstSeenAt = T  • hasScrobbled = true             • hasScrobbled was true
• hasScrobbled = false • EMIT SCROBBLE                   • Reset session:
                         (timestamp = playFirstSeenAt)     - playFirstSeenAt = now
                                                           - hasScrobbled = false
                                                           - listenRanges = []
                                                         • Play #2 begins!
```

1. **New Play Starts**:
   - `this.currentPlay` is set.
   - `this.hasScrobbled = false`.
   - `this.playFirstSeenAt` is set to the track's true start time.
2. **50% or 4 Minutes Reached**:
   - In `player.update(...)`, when `!this.hasScrobbled && this.passesScrobbleThreshold()`:
   - Mark `this.hasScrobbled = true`.
   - Return the play as a newly completed scrobble candidate.
   - The player continues updating progress for "Now Playing" UI without double-scrobbling.
3. **Rewind / Repeat**:
   - If incoming position for the same track drops backwards by an amount that satisfies the scrobble threshold (`timePassesScrobbleThreshold(thresholds, lastPosition - newPosition, duration).passes` while `hasScrobbled === true`):
   - This is recognized as a **Replay**.
   - Reset:
     - `this.hasScrobbled = false`
     - `this.playFirstSeenAt = reportedTS ?? dayjs()`
     - `this.listenRanges = []`
     - `this.currentListenRange = undefined`
   - Play #2 starts accumulating fresh listen time. When it reaches 50%, Play #2 scrobbles!
4. **Skip to Next Track, Then Click Back (A -> B -> A)**:
   - When Song B plays: Song A's session is already scrobbled. Song B starts with `hasScrobbled = false`.
   - When user clicks back to Song A after 3s: Song B has not met the threshold (<50%) and is discarded. Song A starts as a fresh play session with `hasScrobbled = false` and its own start timestamp. When it hits 50%, Play #2 scrobbles!

---

### 3.2 Deduplication Rules: 30-Second Window

1. **Live vs. Live Replays**:
   - Live plays tracked by the active player state have distinct start timestamps (`playDate_2 > playDate_1`).
   - They are **never** duplicates of each other.
   - In `PlayRepository.checkExisting`, the duplicate search window for live player plays is strictly `[playedAt - 30s, playedAt + 30s]`. The backward `duration` subtraction is completely removed for live plays.
2. **Live vs. Spotify Backlog Reconcile**:
   - Spotify backlog (`getMyRecentlyPlayedTracks`) returns tracks with `played_at` (completion timestamp).
   - A backlog play is a duplicate of a live play if:
     `|backlog.played_at - (live.playDate + live.listenedFor)| <= 30s` (or `|backlog.played_at - live.playDateCompleted| <= 30s`).
   - If true, the backlog play is marked as `Dupe` and ignored.
   - If you played tracks on repeat while offline, each backlog entry has a distinct completion timestamp spaced ~duration apart (>30s), so each offline play is scrobbled independently.
3. **Disable False Fuzzy Matching in Scrobblers**:
   - In `TimeUtils.comparePlayTemporally`, remove `TA_FUZZY` matching where `|playDiff - duration| <= 10s` for consecutive plays of the same track.

---

## 4. Detailed File-by-File Changes

### 3.1 `src/backend/sources/SpotifySource.ts`
* **File**: `src/backend/sources/SpotifySource.ts`
* **Function**: `formatPlayObj` (around line 178)
* **Change**:
  Calculate exact start time from Spotify's payload rather than using the snapshot time:
  ```typescript
  // Spotify provides server snapshot timestamp and progress_ms:
  // timestamp - progress_ms = exact start millisecond!
  const startTimestamp = (progress_ms !== null && progress_ms !== undefined)
      ? timestamp - progress_ms
      : timestamp;
  played_at = dayjs(startTimestamp);
  ```

### 3.2 `src/backend/sources/PlayerState/AbstractPlayerState.ts`
* **File**: `src/backend/sources/PlayerState/AbstractPlayerState.ts`
* **Changes**:
  1. Add property `protected hasScrobbled: boolean = false;`.
  2. In `setCurrentPlay()`:
     - Initialize `this.hasScrobbled = false;`.
  3. Replace the overcomplicated `isSessionRepeat()` with a clean rewind check:
     ```typescript
     protected isPositionRewind(newPosition?: number): boolean {
         if (this.currentPlay === undefined || newPosition === undefined || !this.hasScrobbled) {
             return false;
         }
         const lastPos = this.getPosition();
         if (lastPos === undefined) {
             return false;
         }
         const duration = this.currentPlay.data.duration;
         const dropped = lastPos - newPosition;
         if (dropped <= 0) {
             return false;
         }
         // Rewind detected if position dropped backwards by at least 50% or 4 minutes
         // (reusing the exact symmetric threshold config that triggered the scrobble)
         return timePassesScrobbleThreshold(this.thresholds, dropped, duration).passes;
     }
     ```
  4. In `setPlay()`:
     - If `this.isPositionRewind(state.position)`:
       - Treat as replay!
       - Reset `this.hasScrobbled = false;`.
       - Reset `this.playFirstSeenAt = reportedTS ?? dayjs();`.
       - Clear `this.listenRanges = [];`.
       - `this.currentListenRange = undefined;`.
       - Start new listening session at `state.position`.
       - Return `[this.requirePlayedObject(), undefined]`.
     - In progress tracking:
       - Check if `!this.hasScrobbled && this.getListenDuration() passes threshold`:
       - If passes:
         - `this.hasScrobbled = true;`
         - Generate played object: `const scrobblePlay = this.getPlayedObject(false);`
         - Return `[this.requirePlayedObject(), scrobblePlay];` so `MemorySource` scrobbles it immediately!
  5. In track transition (`!this.incomingPlayMatchesExisting(play)`):
     - If `!this.hasScrobbled` and it met threshold: emit it.
     - If `this.hasScrobbled`: do NOT re-emit it (it was already scrobbled at 50%).

### 3.3 `src/backend/sources/MemorySource.ts`
* **File**: `src/backend/sources/MemorySource.ts`
* **Changes**:
  1. In `processRecentPlays`:
     - Allow candidate plays emitted when `hasScrobbled` triggers at 50% to be discovered immediately.
  2. In `isListenedPlayDiscoverable`:
     - **Remove** lines 381–386:
       ```typescript
       // REMOVE THIS:
       if (playDate.isAfter(rplayDate.add(duration, 's')))
       ```
     - For plays originating from a live player (`PARSED_FROM.player`):
       - If `candidate.data.playDate` is distinct from previous play's `playDate` (diff > 30s), it is discoverable! Do not lock it behind `rplayDate + duration`.

### 3.4 `src/backend/common/database/drizzle/repositories/PlayRepository.ts`
* **File**: `src/backend/common/database/drizzle/repositories/PlayRepository.ts`
* **Changes**:
  1. In `getTemporallyCloseDateCompareOp`:
     - When checking a live player play (`PARSED_FROM.player` or default check), do NOT subtract `play.data.duration` from `startRange`.
     - Set `startRange = playDate.subtract(30, 'seconds')` and `endRange = playDate.add(30, 'seconds')`.
     - Only expand the window with `useDuration` when reconciling an end-timestamp backlog play (`SCROBBLE_TS_SOC_END`) against a live play.

### 3.5 `src/backend/utils/TimeUtils.ts`
* **File**: `src/backend/utils/TimeUtils.ts`
* **Changes**:
  1. In `comparePlayTemporally`:
     - In the `fuzzyDurationDiff` block (lines 220–225):
       ```typescript
       // Only perform fuzzy duration matching if candidate playDate is NOT sequentially after existingPlayDate
       // Two consecutive plays of the same song have diff ≈ duration, which is NOT a duplicate!
       if (result.match === TA_NONE && referenceDuration !== undefined && !isSequentialPlay) {
           result.date.fuzzyDurationDiff = Math.abs(scrobblePlayDiff - referenceDuration);
           if (result.date.fuzzyDurationDiff <= fuzzyDiffThreshold) {
               result.match = TA_FUZZY;
           }
       }
       ```

---

## 5. Verification & Testing Steps

1. **Unit Tests (`src/backend/tests/player/player.test.ts`)**:
   - Add test: `scrobbles immediately when reaching 50% of duration`.
   - Add test: `resets session and scrobbles second play when rewound after 50%`.
   - Add test: `does not double-scrobble when track finishes after being scrobbled at 50%`.
   - Add test: `handles rapid track switch (Song A -> Song B for 3s -> Song A) as two distinct plays of Song A`.
2. **Deduplication Tests (`src/backend/tests/database/playRepository.test.ts`)**:
   - Add test: `checkExisting does not flag sequential replays (spaced by duration) as duplicates`.
   - Add test: `checkExisting correctly flags true duplicates within 30 seconds`.
3. **Live End-to-End Test (Manual Verification with Spotify)**:
   - Play a 3-minute track on Spotify.
   - At 1:30 (50%), verify scrobble appears in Koito, Maloja, and ListenBrainz.
   - At 2:40, click rewind back to 0:00.
   - At 1:30 of the second play, verify second scrobble appears in Koito, Maloja, and ListenBrainz.
   - Check multi-scrobbler logs: ensure `Duped` is NOT logged for the replay.
   - Wait 15 minutes for the Spotify Reconcile task to run: ensure the backlog task marks the plays as already scrobbled without re-scrobbling.
