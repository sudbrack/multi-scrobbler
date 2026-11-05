# Architectural Plan: Bulletproof Replays, 50% Scrobbling & Spotify History Reconciliation

## 1. Executive Summary & Core Objectives

### The Problem
In `multi-scrobbler`, Spotify replay tracking (e.g. rewinding near the end of a track, looping intro riffs, or skipping to the next song for a few seconds and clicking back) suffered from three major failure modes:
1. **Missed Listens**: Rewinds were either missed and merged into the previous play as a mere seek, or blocked in `MemorySource` by artificial duration locks.
2. **False Duplicate Flags (`Dupe`)**: Database and client deduplication algorithms expanded backward search windows by the track's entire `duration`, causing sequential replays of the same song to match each other as duplicates.
3. **History Reconcile Mismatches & Zombie Skips**: Background reconciliation from Spotify's Recently Played API (`/v1/me/player/recently-played`) collided with live-tracked plays due to pauses and early skips, while also resurrecting 30-second skips that the live player deliberately rejected.

### The Solution Architecture
Adopt the **Web Scrobbler / ListenBrainz Model**:
1. **The 50% Scrobble Trigger**: As soon as a track accumulates 50% of its duration (or 4 minutes) of listen time, it is marked as scrobbled and emitted immediately.
2. **Cumulative Listening Model (Pre-50%)**: Any seeking, looping, or rewinding *before* reaching 50% is treated strictly as seeking within the same play session. Listened seconds continuously accumulate into `listenedFor`. No replay detection occurs before 50%.
3. **Symmetric Rewind Detection with Start Guard (Post-50% Replay)**: Once `hasScrobbled === true`, a replay is detected if the playback position drops backwards by at least 50% (or 4 minutes) **AND** the new position lands near the start of the track (<= 30s or <= 15% of duration). When triggered, the current session closes and a fresh listening session initializes for Play #2.
4. **Clean 30-Second Deduplication**: Deduplication across identical live sequential tracks only matches if timestamps fall within a narrow **±30-second window**. Eliminate duration-spanning search windows and false fuzzy matches for live sequential plays.
5. **Completion-Window & Discard-Aware History Reconcile**: Reconcile Spotify backlog plays by matching Spotify's completion timestamp (`pa`) against a completion window `[playDate + listenedFor - 30s, playDate + duration + 30s]`. Persist skipped tracks as `state: 'discarded'` so history reconciliation does not resurrect sub-50% skips, while fully recovering genuine missed plays from Spotify API transient blackouts.

---

## 2. "Go Nuclear" Directive: Aggressive Cleanup of Overengineering

**Guideline for the implementing agent**: Do **NOT** preserve defensive workarounds, obsolete fallback heuristics, or dead branches "just in case". The previous bugs in `multi-scrobbler` were directly caused by over-defensive, layered guessing. Clean it up aggressively:

* **Delete Obsolete Repeat Heuristics**: Remove `closeToPlayStart`, `closeToPlayEnd`, and `repeatDurationPlayed` from `TimeUtils.ts`, along with their associated constants (`DEFAULT_CLOSE_POSITION_*`, `DEFAULT_DURATION_REPEAT_*`).
* **Rip Out the `isSessionRepeat` Maze**: Replace the multi-condition, 75-line guessing logic in `AbstractPlayerState.ts` with the clean, two-condition `isPositionRewind` check that only activates *after* the track has scrobbled.
* **Rip Out Artificial Duration Locks**: Remove duration-locking blocks (e.g. `playDate.isAfter(rplayDate.add(duration))`) from `MemorySource.ts`. Live plays from an active player are verified in real time and do not need duration locking.
* **Rip Out Duration-Spanning Search Windows for Live Plays**: Stop subtracting track duration from start ranges in `PlayRepository.ts` when querying live player plays. Live sequential plays are distinct events, not duplicates.
* **Prioritize Simple Invariants**: Keep functions short, clear, and readable. Avoid nested `if/else` guessing ladders.

---

## 3. Core Architecture & Lifecycle

### 3.1 Live Player Lifecycle (`AbstractPlayerState`)

```
T = 0:00               T = 1:30 (50%)                    T = 2:40 (Rewind)
   │                          │                                 │
   ▼                          ▼                                 ▼
Track Starts           Threshold Met!                    Position drops to 0:05
• playFirstSeenAt = T  • hasScrobbled = true             • hasScrobbled was true
• hasScrobbled = false • EMIT SCROBBLE                   • Drop >= 50% AND Pos <= 30s:
                         (timestamp = playFirstSeenAt)   • Reset session:
                                                           - playFirstSeenAt = now
                                                           - hasScrobbled = false
                                                           - listenRanges = []
                                                         • Play #2 begins!
```

1. **New Play Starts**:
   - Initialize `hasScrobbled = false`.
   - Set `playFirstSeenAt` to the track's true start timestamp (derived from Spotify server timestamp minus progress, not snapshot reception time).
2. **Cumulative Listening (Pre-50%)**:
   - Any rewinds, intro loops, or backward seeks before reaching 50% are treated as normal seeking.
   - Each seek ends the current `ListenRange` and begins a new one.
   - Total duration across all ranges accumulates into `listenedFor`.
   - This total is track-duration-invariant and can legitimately exceed 100% of the track length if the listener loops sections before scrobbling.
   - No replay detection is performed while `hasScrobbled === false`.
3. **Threshold Reached (Immediate Scrobble)**:
   - When cumulative `listenedFor` satisfies the threshold (>= 50% of duration or >= 4 minutes):
     - Set `hasScrobbled = true`.
     - Emit the play immediately as a completed scrobble candidate.
     - Continue tracking progress for the "Now Playing" UI without double-scrobbling.
4. **Post-50% Rewind (Replay Detection with Start Guard)**:
   - To qualify as a Replay, an incoming playback update must satisfy:
     1. `hasScrobbled === true` (track already qualified for its first scrobble).
     2. `dropped >= threshold` (position dropped backwards by >= 50% of duration or >= 4 minutes).
     3. **Start Guard**: `newPosition <= Math.max(30, duration * 0.15)` (the user actually rewound near the beginning of the track, within the first 30 seconds or 15%).
   - **Why the Start Guard is critical**: On long tracks (e.g. 10–15 minute songs or podcasts), seeking backward from 8:00 to 3:30 drops 4.5 minutes. Without the start guard, that mid-track scrub would falsely trigger a brand new replay session. The start guard ensures only genuine restarts trigger Play #2.
   - When conditions are met:
     - Recognize as a **Replay**.
     - Reset `hasScrobbled = false`.
     - Reset `playFirstSeenAt` to the current timestamp.
     - Clear `listenRanges`.
     - Begin Play #2 as a fresh listening session. When Play #2 hits 50%, it scrobbles with its own timestamp.
5. **Rapid Track Switches (A → B → A)**:
   - If Song B plays, Song A's session is terminated.
   - If the user clicks back to Song A after a few seconds: Song B has not reached 50% and is recorded as discarded. Song A begins as a brand new play session with `hasScrobbled = false` and its own start timestamp.

---

### 3.2 Deduplication Invariants

1. **Live vs. Live Replays**:
   - Consecutive live plays emitted by an active player have distinct start timestamps spaced apart by listening time.
   - Live player deduplication must strictly use a **narrow ±30-second window** around `playedAt`.
   - Live sequential plays of the same song must **never** be treated as duplicates.
2. **Disable False Fuzzy Matching in Scrobbler Clients**:
   - In temporal comparisons (`TimeUtils`), disable fuzzy duration matching (`|playDiff - duration| <= 10s`) for consecutive sequential plays of the same track.

---

## 4. Spotify History API Reconciliation

Multi-scrobbler periodically reconciles play history using Spotify's `getMyRecentlyPlayedTracks` API (via a 15-minute background task). This reconciler serves an essential role: **recovering missed listens during offline periods or Spotify API transient blackouts** (e.g. when Spotify's `/v1/me/player` live endpoint drops or returns 204 for several tracks while backend history continues recording).

> [!IMPORTANT]
> **FYI — Spotify's 30-Second History Threshold**:
> Spotify's internal tracking logs a track to the `/v1/me/player/recently-played` API as soon as it has been played for **at least 30 seconds** (matching their royalty payout threshold). It does **not** enforce a 50% rule.

### The Tri-State Reconcile Model

```
                    Spotify History Item Arrives (End Timestamp = pa)
                                            │
                                            ▼
                    Query Database for Matching Track in History Window:
                [pa falls within live.playDate + live.listenedFor - 30s
                                    to live.playDate + live.duration + 30s]
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
             MATCH FOUND IN DB                              NO RECORD IN DB
                    │                                               │
     ┌──────────────┴──────────────┐                                ▼
     ▼                             ▼                    GENUINE MISSED PLAY!
State = 'scrobbled'         State = 'discarded'         (e.g. Spotify API blackout,
     │                             │                     network drop, or offline)
     ▼                             ▼                                │
Already Scrobbled!          Live Player rejected                    ▼
Mark as DUPED.              (< 50% threshold).             SCROBBLE IT FRESH!
(No duplicate)              DO NOT RESURRECT.
```

### Critical Rules for History Reconciling:

1. **Match on the "Completion Window", NOT `pa - duration`**:
   - Spotify History provides completion timestamp `pa` (`playDateCompleted`).
   - Calculating start time as `pa - duration` fails whenever the listener paused or skipped after 50% (e.g. at 60%), causing timestamp drift of 60–120s and triggering false duplicate scrobbles.
   - **The Invariant**: A live play that scrobbled at 50% ended somewhere between $(T_{start} + \text{listenedFor})$ and $(T_{start} + \text{duration})$.
   - To match a history item against an existing live play, check whether `pa` falls within:
     $$[\text{playDate} + \text{listenedFor} - 30\text{s}, \;\; \text{playDate} + \text{duration} + 30\text{s}]$$
   - This naturally accommodates pauses, early skips (50%–99%), and normal completions.

2. **Persist Skipped Tracks (`state: 'discarded'`) to Prevent Zombie Resurrections**:
   - When the live player detects an explicit skip before 50% (e.g. user skipped after 35s), write the play to the database with `state: 'discarded'`.
   - When the 15-minute History Reconciler encounters that 35s track from Spotify History, it finds the `state: 'discarded'` record in the database.
   - The reconciler recognizes that the live player explicitly evaluated and rejected this track, and does **not** resurrect it.

3. **Recovering Spotify API Blackouts (Missed Plays)**:
   - When Spotify's live playback endpoint drops out transiently (missing 2–3 songs in a row), the live player never saw those tracks.
   - The database contains **no record** for them (neither `scrobbled` nor `discarded`).
   - The History Reconciler finds no match in the database, correctly recognizes them as legitimate missed listens, and scrobbles them immediately.

4. **In-Flight Grace Buffer**:
   - The 15-minute reconcile task should ignore history tracks with `played_at` timestamps within the last 2 minutes to prevent racing with active live player state transitions and in-flight database commits.

---

## 5. Architectural Responsibilities by Component

* **`AbstractPlayerState`**:
  - Manages `hasScrobbled` state.
  - Accumulates `listenRanges` into duration-invariant `listenedFor`.
  - Emits scrobble immediately upon hitting the threshold.
  - Evaluates `isPositionRewind` with both the threshold drop check AND the start guard (`newPosition <= Math.max(30, duration * 0.15)`).
* **`MemorySource`**:
  - Discovers candidate plays emitted at 50% immediately without duration locking.
  - When a track transitions without meeting threshold, persists it to the database with `state: 'discarded'`.
* **`PlayRepository`**:
  - Restricts duplicate search windows for live plays to strictly `[playedAt - 30s, playedAt + 30s]`.
  - For backlog queries, checks completion window matching against existing plays across all states (`scrobbled`, `discarded`).
* **`TimeUtils` & `PlayComparisonUtils`**:
  - Disables fuzzy duration matching for sequential plays.
  - Matches backlog candidates against live plays using completion-window comparison.
* **`SpotifySource`**:
  - Uses `timestamp - progress_ms` for exact live start timestamps.
  - Preserves completion timestamp `pa` for history items.
  - Adds a 2-minute safety grace buffer to the periodic reconcile job.

---

## 6. Verification Checklist for the Implementing Agent

1. **Live Scrobble Timing**: Verify scrobbles emit at 50% of track duration (or 4 minutes), not at track end.
2. **Cumulative Listening**: Verify seeking backwards before 50% keeps accumulating listen time and scrobbles once cumulative duration hits 50%, even if total duration exceeds 100%.
3. **Replays with Start Guard**:
   - Verify rewinding to 0:05 after 50% cleanly resets state and emits a second scrobble once the replay reaches 50%.
   - Verify rewinding from 8:00 to 3:30 on a 12-minute track does NOT trigger a replay.
4. **Deduplication**: Verify sequential replays of identical tracks are never flagged as duplicates.
5. **Early Skips & Pauses vs. Reconcile**: Verify pausing for 2 minutes or skipping at 60% does not cause duplicate scrobbles when the 15-minute history reconcile runs.
6. **Sub-50% Skips vs. Reconcile**: Verify skipping a track at 35 seconds records `state: 'discarded'` and is NOT resurrected by the 15-minute history reconcile.
7. **Spotify API Blackout Recovery**: Verify that if 3 tracks are completely missed by live tracking, the 15-minute history reconcile detects no existing DB record and successfully backfills all 3 tracks.
