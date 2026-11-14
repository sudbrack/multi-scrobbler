# Architectural Plan: Session-End Scrobbling, Start-Guarded Replays & Spotify History Reconciliation

## 1. Executive Summary

### The Problem
In `multi-scrobbler`, live playback tracking (particularly with Spotify) and background history reconciliation suffer from three interconnected failure modes:
1. **Missed or Misclassified Replays**:
   - Rewinding a track near the end (or looping sections before 50%) is governed by a complex multi-branch heuristic in `AbstractPlayerState.isSessionRepeat` (`closeToPlayStart`, `closeToPlayEnd`, `repeatDurationPlayed`) that either misses legitimate replays after 50% or prematurely splits a play when a user rewinds before reaching 50%.
   - Even when a player detects a repeat, `MemorySource.isListenedPlayDiscoverable` enforces an artificial duration lock (`playDate.isAfter(rplayDate.add(duration, 's'))`), blocking replays whenever the previous listen was rewound before 100% of the track duration elapsed.
2. **False Duplicate Flags on Sequential Plays**:
   - `PlayRepository.getTemporallyCloseDateCompareOp` expands search windows by `duration` for all queries, and `comparePlayTemporally` / `existingScrobble` apply `TA_DURING` and `TA_FUZZY` (`|playDiff - duration| <= 10s`) even when comparing two live player plays. Consecutive plays of the same song are therefore flagged as duplicates of each other.
3. **History Reconcile Mismatches & Zombie Skips**:
   - Spotify's `/v1/me/player/recently-played` API reports only the completion timestamp (`played_at`) and logs any track played for **>= 30 seconds** (rather than 50%).
   - When the user pauses mid-track, rewinds before 50%, or skips after 50% (e.g. at 60%), the completion timestamp drifts from `playDate + duration`, causing the 15-minute history reconcile job to scrobble a duplicate.
   - When the user skips a track between 30s and 50% (e.g. at 35s), the live player rightly rejects it, but the 15-minute history reconcile job sees no record in the database and resurrects it as a "zombie" scrobble.

---

### The Solution Overview
1. **Cumulative Pre-50% Listening & 50% Replay Qualification (`hasScrobbled`)**:
   - Any backward seek or loop *before* reaching the scrobble threshold (default 50% of duration or 4 minutes) is treated strictly as seeking within the same play session. Listened ranges accumulate into `listenedFor` without triggering a repeat.
   - Once cumulative `listenedFor` meets the configured scrobble threshold, `hasScrobbled` is set to `true`, qualifying the session for scrobbling and arming post-50% replay detection.
2. **Session-End Emission for Full Listening Duration**:
   - While a track is actively playing, emission waits until the listening session ends (`prevPlay` on track transition, `prevPlay` on post-50% replay rewind, or `cleanupPlay` when a paused player becomes stale).
   - This guarantees downstream clients that record listening duration (Maloja, ListenBrainz, Koito) receive the full, accurate `listenedFor` and `playDateCompleted` rather than a premature 50% truncation.
3. **Start-Guarded Post-50% Replay Detection (`isSessionRepeat`)**:
   - Once `hasScrobbled === true`, a backward seek triggers a repeat if and only if:
     1. The playback position drops backwards by at least the scrobble threshold (`lastPos - position >= min(duration * percent, durationThreshold)`), **AND**
     2. The new position lands within the **30-second start guard** (`position <= 30`).
   - When triggered, Play #1 closes and emits as `prevPlay` with its full accumulated `listenedFor` and `playDateCompleted`, and Play #2 begins cleanly with a fresh `playFirstSeenAt` and empty `listenRanges`.
4. **Scoped Live-Play Deduplication (`±30s`) Without Breaking Non-Player Fuzzy Matching**:
   - Live player plays (`parsedFrom === 'player'` / `newFromSource === true`) use a strict `[playDate - 30s, playDate + 30s]` database lookup window and do not match against other live plays via `TA_DURING` or `TA_FUZZY`.
   - Non-player sources (e.g. comparing start-timestamped vs. end-timestamped history/scrobbler sources) retain existing `TA_FUZZY` behavior so all existing scrobbler client tests continue to pass without modification.
5. **Completion-Window & Discard-Aware History Reconciliation**:
   - Sub-threshold skips (`listenedFor > 0` when a track transitions or is orphaned without meeting the scrobble threshold) are persisted to the database with `state: 'discarded'`.
   - Backlog/history candidates (`parsedFrom: 'backlog' | 'history'` or `scrobbleTsSOC === SCROBBLE_TS_SOC_END`) query across all states (including `discarded`) and match against a live play's **completion window**:
     $$[\text{playDate} + \text{minCompletionOffset} - 30\text{s}, \;\; \max(\text{playDate} + \text{duration},\; \text{playDateCompleted},\; \text{pauseProjectedEnd}) + 30\text{s}]$$
   - Genuine missed plays from Spotify API transient blackouts (which have neither a `scrobbled`/`discovered` nor a `discarded` record in the DB) are cleanly backfilled.

---

## 2. Upstream-Ready Design Principles

To ensure these changes are clean, minimal, and idiomatic for upstream contribution:
* **Preserve Method Signatures & Public APIs**: Keep `AbstractPlayerState.isSessionRepeat` (and its override in `SubsonicPlayerState`) rather than renaming to `isPositionRewind`.
* **Preserve Non-Player Temporal Comparison Behavior**: Do not disable `TA_FUZZY` globally for non-player sources; scope the `TA_FUZZY` / `TA_DURING` exclusion specifically to confirmed live player plays (`parsedFrom === PARSED_FROM.player`, `newFromSource === true`, `repeat === true`). Existing tests in `scrobblers.test.ts` must pass untouched.
* **Use Upstream Resource Cleanup (`disposeListenRanges`)**: Always call `this.disposeListenRanges()` when resetting listen ranges so `RealtimePlayer` timers are properly disposed.
* **Remove Dead Positional Heuristics Cleanly**: Remove `closeToPlayStart`, `closeToPlayEnd`, `repeatDurationPlayed` from `TimeUtils.ts` and their unused `DEFAULT_CLOSE_POSITION_*` / `DEFAULT_DURATION_REPEAT_*` constants from `Atomic.ts`.

---

## 3. Core Architecture & Lifecycle

### 3.1 Live Player Lifecycle (`AbstractPlayerState` & `MemorySource`)

```
T = 0:00               T = 1:30 (50%)                    T = 2:40 (Rewind to 0:05)
   │                          │                                 │
   ▼                          ▼                                 ▼
Track Starts           Threshold Met!                    Position drops to 0:05
• playFirstSeenAt = T  • hasScrobbled = true             • hasScrobbled === true
• hasScrobbled = false • Replay detection armed          • Drop >= 50% AND Pos <= 30s:
• hasEmitted = false   • Actively playing: defer         • Close & emit Play #1 (prevPlay)
                         emission until session ends       with full 160s listenedFor!
                         for accurate listenedFor        • Reset session for Play #2:
                                                           - playFirstSeenAt = reportedTS
                                                           - hasScrobbled = false
                                                           - hasEmitted = false
                                                           - disposeListenRanges()
```

1. **New Play Initialization (`setCurrentPlay`)**:
   - Initialize `hasScrobbled = false` and `hasEmittedCurrentPlay = false`.
   - If `!isRepeat` and the play provides a start-anchored `playDate` (`scrobbleTsSOC === SCROBBLE_TS_SOC_START` or `newFromSource === true` without `reportedTS`), set `playFirstSeenAt = play.data.playDate`; otherwise use `reportedTS ?? dayjs()`.
   - In `SpotifySource.formatPlayObj`, compute live `played_at` as `dayjs(timestamp).subtract(progress_ms, 'ms')` so `playFirstSeenAt` reflects the true track start time.
2. **Pre-50% Seeking & Cumulative Listening**:
   - While `hasScrobbled === false`, `isSessionRepeat` always returns `false`.
   - Backward or forward seeks close the current `ListenRange` and start a new one (in `PositionalPlayerState.currentListenSessionContinue`, only snap `position <= 3` to `1` when `this.listenRanges.length === 0` so rewinding to `0s` mid-session records `0s` accurately).
   - `getListenDuration()` sums all completed `listenRanges` plus `currentListenRange`.
3. **50% Threshold Qualification (`passesScrobbleThreshold`)**:
   - After updating the listen session in `AbstractPlayerState.update()`, check `if (!this.hasScrobbled && this.passesScrobbleThreshold()) { this.hasScrobbled = true; }`.
   - `passesScrobbleThreshold()` uses `timePassesScrobbleThreshold(this.scrobbleThresholds, this.getListenDuration(), this.currentPlay.data.duration)`.
4. **Post-50% Rewind Detection (`isSessionRepeat`)**:
   - In `AbstractPlayerState.isSessionRepeat(position, reportedTS)`:
     1. Require `this.hasScrobbled === true`, `this.currentPlay !== undefined`, and `position !== undefined`.
     2. If `this.currentListenRange !== undefined`, verify `seeked(position, reportedTS)` indicates a backward seek (`isSeeked && seekPos < 0`).
     3. Determine `lastPos` from `this.currentListenRange?.getPosition()` or the last finalized range in `this.listenRanges`. Require `lastPos !== undefined && position < lastPos`.
     4. Compute `threshold = (trackDur !== undefined && trackDur > 0) ? Math.min(trackDur * (percentThreshold / 100), durationThreshold) : durationThreshold`.
     5. Return `true` iff `(lastPos - position) >= threshold && position <= 30`.
   - Note on `Start Guard (position <= 30)`: Prevents mid-track backward scrubs on long tracks (e.g. seeking from 8:00 back to 3:30 on a 12-minute song) from falsely triggering a new replay session.
   - In `SubsonicPlayerState.isSessionRepeat`, delegate to `super.isSessionRepeat(position, reportedTS)` when positional data is present, and gate the non-positional `> 105%` duration fallback with `this.hasScrobbled`.
5. **Session End, Stale Cleanup & Resume Updates (`MemorySource`)**:
   - **Normal Transition / Replay (`prevPlay !== undefined`)**:
     - If `wasEmittedBeforeUpdate` is `true` (because the play was already emitted while stale-paused), call `updateCompletedPlay(prevPlay)` to update `playDateCompleted`, `listenedFor`, and `listenRanges` on the existing DB/cache record without re-scrobbling.
     - Otherwise, check `isListenedPlayDiscoverable(prevPlay)`. If discoverable, emit `prevPlay`. If not discoverable and `prevPlay.data.listenedFor > 0`, persist as `state: 'discarded'` via `persistDiscardedPlay(prevPlay)`.
   - **Stale In-Progress Play (`isUpdateStale()` or `cleanupPlayer`)**:
     - If `!player.hasEmittedCurrentPlay`, evaluate `cleanupPlay = player.getPlayedObject(true)`. If discoverable, emit it and set `player.hasEmittedCurrentPlay = true` and `player.hasScrobbled = true` (keeping `listenRanges` intact so if the user later unpauses and either finishes the track or rewinds to `0:00`, the player state remains continuous).
     - When an orphaned player is deleted (`deletePlayer`) and `!player.hasEmittedCurrentPlay`, if `cleanupPlay` has `listenedFor > 0`, persist it as `state: 'discarded'`.

---

### 3.2 Deduplication & Temporal Comparison Invariants

1. **No Artificial Duration Lock in `MemorySource.isListenedPlayDiscoverable`**:
   - When `existingDiscovered(candidate)` returns a match, only reject if `playDate.isSame(rplayDate)`. Do not require `playDate.isAfter(rplayDate.add(duration, 's'))`.
2. **Database Lookup Window (`PlayRepository.getTemporallyCloseDateCompareOp`)**:
   - Identify backlog/history plays via:
     `isBacklogOrHistory = (play.meta.parsedFrom !== undefined && [PARSED_FROM.backlog, PARSED_FROM.history].includes(play.meta.parsedFrom)) || SOT === SCROBBLE_TS_SOC_END`
   - **For Live Plays (`!isBacklogOrHistory`)**:
     - Use `[anchor - 30s, anchor + 30s]` (`bufferTime = 30`), without adding or subtracting `duration`.
     - Exclude `state: 'discarded'` by default in `findExistingPlay` and `getTemporallyClosePlays` when `states` is not specified so rapid skipped tracks (e.g. `Song A (4s skip) -> Song B (3s skip) -> Song A (full listen)`) never collide with a live play.
   - **For Backlog/History Plays (`isBacklogOrHistory`)**:
     - Use `[sotPlayDate - (dur + 300 + bufferTime), sotPlayDate + bufferTime]` when `useDuration` is enabled (`getTemporallyClosePlays` passes `useDuration: true`), ensuring plays that were paused mid-track are still fetched as candidates.
     - Include all states (including `'discarded'`) and include `TA_DURING` in `effectiveTaAccuracy`.
3. **Temporal Comparison (`TimeUtils.comparePlayTemporally` & `PlayComparisonUtils.existingScrobble`)**:
   - Define `candidateIsLive = candidatePlay.meta.parsedFrom === PARSED_FROM.player || candidatePlay.meta.newFromSource === true || (candidatePlay.data.listenRanges !== undefined && candidatePlay.data.listenRanges.length > 0)`.
   - When both `candidateIsLive` and `existingIsLive` are true, compare `playDate` directly rather than `scrobbleTsSOCDate`.
   - When `candidateIsLive` is true (or `playObj.data.repeat === true`), do not use `TA_DURING` (`duringReferences = []`) and do not use `TA_FUZZY` in `existingScrobble`.
   - When `candidateIsLive` is false (e.g. scrobbler client checks or generic non-player sources), preserve existing `TA_FUZZY` behavior so non-player sources comparing start vs. end timestamps continue to work as designed.

---

## 4. Spotify History Reconciliation

```
                 Spotify History Item Arrives (Completion Timestamp = pa)
                                            │
                                            ▼
                 Query DB & Cache for Matching Track in Completion Window:
               [playDate + minCompletionOffset - 30s
                    to max(playDate + duration, playDateCompleted, pauseProjectedEnd) + 30s]
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
             MATCH FOUND IN DB                              NO RECORD IN DB
                    │                                               │
     ┌──────────────┴──────────────┐                                ▼
     ▼                             ▼                    GENUINE MISSED PLAY!
State = 'discovered' /      State = 'discarded'         (e.g. Spotify API blackout,
        'scrobbled'                │                     network drop, or offline)
     │                             ▼                                │
     ▼                      Live Player rejected                    ▼
Already Scrobbled!          (< 50% threshold).             SCROBBLE IT FRESH!
Suppress duplicate.         DO NOT RESURRECT.
```

### Reconciliation Rules
1. **Completion Window Calculation (`TimeUtils.comparePlayTemporally`)**:
   - When a backlog/history candidate is compared against a live-tracked play (`duringReferences` includes `'duration'` or `'listenedFor'`):
     - `listenedOffset = existingPlay.data.listenedFor ?? 0`
     - `minCompletionOffset = (existingRanges !== undefined && existingRanges.length > 1) ? Math.min(listenedOffset, 30) : listenedOffset`
       *(When a user rewinds before 50% and then completes the track, Spotify History may log both an intermediate entry at the rewind point and a final completion entry; anchoring `minCompletionOffset` at `min(listenedOffset, 30)` absorbs the intermediate history entry as well).*
     - `windowStart = existingPlayDate.add(minCompletionOffset, 's').subtract(30, 's')`
     - `baseEnd = max(existingPlayDate + max(duration, listenedOffset), playDateCompleted, lastRange.end.timestamp + max(0, duration - (lastRange.end.position ?? listenedOffset)))`
     - `windowEnd = baseEnd.add(30, 's')`
     - If `candidateTsSOCDate.isBetween(windowStart, windowEnd, undefined, '[]')`, return `TA_DURING`.
2. **Discarded Play Lookup in `AbstractSource.existingDiscovered`**:
   - Keep `getRecentPlays` filtering out `['queued', 'discarded']` for normal operations.
   - When `existingDiscovered(play)` is called for a backlog/history play (`isBacklogOrHistory`), also query `this.playRepo.getTemporallyClosePlays(play, { states: ['discarded'] })` and append those candidates to the comparison list so sub-50% skips are matched and suppressed before entering the discovery queue.
3. **Preserve History Timestamp & 2-Minute Grace Cutoff (`SpotifySource`)**:
   - In `SpotifySource.getRecentlyPlayed`, do not overwrite `scrobbleTsSOC` on live plays with `SCROBBLE_TS_SOC_END` (live plays already set `SCROBBLE_TS_SOC_START`, while history plays set `SCROBBLE_TS_SOC_END` in `formatPlayObj`).
   - In `SpotifySource.getBackloggedPlays`, filter out history items whose timestamp (`playDateCompleted ?? playDate`) is within the last **2 minutes** (`dayjs().subtract(2, 'minutes')`) so the 15-minute background reconcile job never races with an active track still playing in `MemorySource`.

---

## 5. File-by-File Implementation Scope

1. **`src/backend/common/infrastructure/Atomic.ts`**:
   - Remove obsolete positional repeat constants (`DEFAULT_CLOSE_POSITION_ABSOLUTE`, `DEFAULT_CLOSE_POSITION_PERCENT`, `DEFAULT_DURATION_REPEAT_ABSOLUTE`, `DEFAULT_DURATION_REPEAT_PERCENT`, `DEFAULT_COMPLETED_POSITION_ABSOLUTE`, `DEFAULT_COMPLETED_POSITION_PERCENT`, `DEFAULT_RESTART_POSITION_PERCENT`).
2. **`src/backend/utils/TimeUtils.ts`**:
   - Remove `closeToPlayStart`, `closeToPlayEnd`, and `repeatDurationPlayed`.
   - Update `comparePlayTemporally` to distinguish `candidateIsLive`, `existingIsLive`, and `candidateIsBacklogOrHistory`, implement the completion-window `TA_DURING` check, and skip `TA_FUZZY` when comparing live plays unless `fuzzyDuration` is explicitly requested.
3. **`src/backend/utils/PlayComparisonUtils.ts`**:
   - In `existingScrobble`, exclude `TA_FUZZY` from `looseTimeAccuracy` when `candidateConfirmedLive` is true (alongside existing `repeat` and `HISTORY`/`INGRESS` checks), while preserving `TA_FUZZY` for non-live sources.
   - Set `duringReferences` to `['range', 'listenedFor', 'duration']` when `!candidateConfirmedLive && existingIsLiveTracked`, and `[]` when `candidateConfirmedLive`.
4. **`src/backend/common/database/drizzle/repositories/PlayRepository.ts`**:
   - In `findExistingPlay` and `getTemporallyClosePlays`, exclude `state: ['discarded']` for non-backlog plays when `states` is unspecified, and include `TA_DURING` in `effectiveTaAccuracy` for backlog/history plays.
   - Pass `useDuration: true` in `getTemporallyClosePlays`.
   - In `getTemporallyCloseDateCompareOp`, use a strict `±30s` window around `playDate` for live plays, and `[sotPlayDate - (dur + 300 + bufferTime), sotPlayDate + bufferTime]` for backlog/history plays.
5. **`src/backend/sources/PlayerState/AbstractPlayerState.ts`**:
   - Thread `scrobbleThresholds` through `createPlayerOptions` and `PlayerStateOptions`.
   - Add `hasScrobbled`, `hasEmittedCurrentPlay`, and `passesScrobbleThreshold()`.
   - Use `this.playLastUpdatedAt ?? dayjs()` for `playDateCompleted` when `completed` is true in `getPlayedObject`.
   - Replace `isSessionRepeat` body with the `hasScrobbled`, `dropped >= threshold`, and `position <= 30` start guard logic.
   - In `setCurrentPlay`, preserve start-anchored `play.data.playDate` as `playFirstSeenAt` on non-repeat plays, and reset `hasScrobbled` / `hasEmittedCurrentPlay` (and copy them in `transferToNewPlayer`).
6. **`src/backend/sources/PlayerState/PositionalPlayerState.ts` & `SubsonicPlayerState.ts`**:
   - In `PositionalPlayerState.currentListenSessionContinue`, only snap `position <= 3` to `1` when `this.listenRanges.length === 0`.
   - In `SubsonicPlayerState.isSessionRepeat`, check `this.activeRange?.isPositional() || position !== undefined` and gate the `> 105%` duration check with `this.hasScrobbled`.
7. **`src/backend/sources/MemorySource.ts` & `AbstractSource.ts`**:
   - Pass `this.config.options?.scrobbleThresholds` in `MemorySource.setNewPlayer`.
   - Add `persistDiscardedPlay` and `updateCompletedPlay` in `MemorySource`.
   - Update `cleanupPlayer` and `processRecentPlays` to handle `hasEmittedCurrentPlay`, update stale-resumed plays on completion, and persist sub-threshold skips as `state: 'discarded'`.
   - Remove the `playDate.isAfter(rplayDate.add(duration, 's'))` block from `isListenedPlayDiscoverable`.
   - In `AbstractSource`, exclude `'discarded'` from `getRecentPlays` and query temporally close `'discarded'` plays in `existingDiscovered` when evaluating backlog/history plays.
8. **`src/backend/sources/SpotifySource.ts`**:
   - Compute `played_at = dayjs(timestamp).subtract(progress_ms, 'ms')` for live tracks in `formatPlayObj`.
   - Keep `scrobbleTsSOC` intact in `getRecentlyPlayed`.
   - Add the 2-minute cutoff filter in `getBackloggedPlays`.

---

## 6. Verification Plan

1. **Unit & Integration Tests**:
   - `src/backend/tests/player/player.test.ts`: Verify `isSessionRepeat` with 50% qualification + 30s start guard, pre-50% cumulative backward seeks exceeding 100% duration, and 12-minute track mid-song scrub immunity.
   - `src/backend/tests/utilitiesTests/time.test.ts` & `src/backend/tests/utils/playComparisons.test.ts`: Verify live vs. live temporal comparisons, explicit `fuzzyDuration`, and completion-window matching (including paused in-flight plays).
   - `src/backend/tests/scrobbler/scrobblers.test.ts`: Verify all existing scrobbler deduplication tests pass without modification, plus sequential live play vs. backlog completion-window test.
   - `src/backend/tests/database/playRepository.test.ts`: Verify strict `±30s` live window and multi-state (`discovered`, `scrobbled`, `discarded`) backlog completion window matching.
   - `src/backend/tests/spotify/spotify.test.ts`: Verify end-to-end scenarios:
     1. Exact start timestamp (`timestamp - progress_ms`) and session-end emission with full `listenedFor`.
     2. Post-50% rewind to `<= 30s` emitting Play #1 with full duration and Play #2 on completion.
     3. Rapid track switches (`A -> B -> A` and sub-10s `A 4s -> B 3s -> A full`) discarding sub-50% skips and scrobbling valid sessions without collision.
     4. History reconcile after early skip (60%), 2-minute mid-track pause, stale pause (> 3m) + unpause/rewind, and pre-50% rewind (40% + 100%) without duplicate scrobbles.
     5. Sub-50% skip (35s) persisted as `discarded` and suppressed during history reconcile.
     6. Recovery of missed tracks from Spotify History after a live API blackout while ignoring in-flight (< 2 min) tracks.
