# Architectural Plan: Bulletproof Replays, 50% Scrobbling & Spotify History Reconciliation

## 1. Executive Summary & Core Objectives

### The Problem
In `multi-scrobbler`, Spotify replay tracking (e.g. rewinding near the end of a track, looping intro riffs, or skipping to the next song for a few seconds and clicking back) suffered from three major failure modes:
1. **Missed Listens**: Rewinds were either missed and merged into the previous play as a mere seek, or blocked in `MemorySource` by artificial duration locks.
2. **False Duplicate Flags (`Dupe`)**: Database and client deduplication algorithms expanded backward search windows by the track's entire `duration`, causing sequential replays of the same song to match each other as duplicates.
3. **History Reconcile Mismatches & Zombie Skips**: Background reconciliation from Spotify's Recently Played API (`/v1/me/player/recently-played`) collided with live-tracked plays due to pauses and early skips, while also resurrecting 30-second skips that the live player deliberately rejected.

### The Solution Architecture
Adopt the **Option A Session-End Scrobble Model with 50% Replay Guarding**:
1. **The 50% Threshold Qualification & Replay Arming**: As soon as a track accumulates 50% of its duration (or 4 minutes) of listen time, `hasScrobbled` is armed to `true`. This qualifies the play for scrobbling and activates post-50% replay detection (`isPositionRewind`).
2. **Session-End Emission for Accurate Listening Time**: To ensure clients tracking actual listening duration (Maloja via `scrobbleData.duration = listenedFor` and ListenBrainz/Koito via `duration_played = Math.floor(play.data.listenedFor)`) receive the full, accurate listening time rather than a premature 50% truncation, live plays are emitted when the listening session ends (`prevPlay` on track transition, `prevPlay` on post-50% rewind replay, or `cleanupPlay` on stale player pause).
3. **Cumulative Listening Model (Pre-50%)**: Any seeking, looping, or rewinding *before* reaching 50% is treated strictly as seeking within the same play session. Listened seconds continuously accumulate into `listenedFor`. No replay detection occurs before 50%.
4. **Symmetric Rewind Detection with Start Guard (Post-50% Replay)**: Once `hasScrobbled === true`, a replay is detected if the playback position drops backwards by at least 50% (or 4 minutes) **AND** the new position lands near the start of the track (<= 30s). When triggered, session #1 closes and emits with full listening duration, and a fresh listening session initializes for Play #2.
5. **Clean 30-Second Deduplication**: Deduplication across identical live sequential tracks only matches if timestamps fall within a narrow **±30-second window**. Eliminate duration-spanning search windows and false fuzzy matches for live sequential plays.
6. **Completion-Window & Discard-Aware History Reconcile**: Reconcile Spotify backlog plays by matching Spotify's completion timestamp (`pa`) against a completion window `[playDate + minCompletionOffset - 30s, max(playDate + duration, playDateCompleted, pauseProjectedEnd) + 30s]`. Persist skipped tracks as `state: 'discarded'` so history reconciliation does not resurrect sub-50% skips, while fully recovering genuine missed plays from Spotify API transient blackouts.

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

### 3.1 Live Player Lifecycle (`AbstractPlayerState` & `MemorySource`)

```
T = 0:00               T = 1:30 (50%)                    T = 2:40 (Rewind)
   │                          │                                 │
   ▼                          ▼                                 ▼
Track Starts           Threshold Met!                    Position drops to 0:05
• playFirstSeenAt = T  • hasScrobbled = true             • hasScrobbled was true
• hasScrobbled = false • Replay Armed                    • Drop >= 50% AND Pos <= 30s:
• hasEmitted = false   • Actively playing: wait          • EMIT Play #1 (prevPlay)
                         until session ends to scrobble    with full 160s duration!
                         full accurate listenedFor!      • Reset session:
                                                           - playFirstSeenAt = now
                                                           - hasScrobbled = false
                                                           - hasEmitted = false
                                                           - listenRanges = []
                                                         • Play #2 begins!
```

1. **New Play Starts**:
   - Initialize `hasScrobbled = false` and `hasEmittedCurrentPlay = false`.
   - Set `playFirstSeenAt` to the track's true start timestamp (derived from Spotify server timestamp minus progress, not snapshot reception time).
2. **Cumulative Listening (Pre-50%)**:
   - Any rewinds, intro loops, or backward seeks before reaching 50% are treated as normal seeking.
   - Each seek ends the current `ListenRange` and begins a new one.
   - Total duration across all ranges accumulates into `listenedFor`.
   - This total is track-duration-invariant and can legitimately exceed 100% of the track length if the listener loops sections before scrobbling.
   - No replay detection is performed while `hasScrobbled === false`.
3. **Threshold Reached (Replay Armed & Qualification)**:
   - When cumulative `listenedFor` satisfies the threshold (>= 50% of duration or >= 4 minutes):
     - Set `hasScrobbled = true`.
     - Arms replay rewind detection.
     - While actively playing, emission is deferred until the listening session completes so clients (like Maloja and ListenBrainz) record accurate total listening time instead of premature 50% duration.
4. **Post-50% Rewind (Replay Detection with Start Guard)**:
   - To qualify as a Replay, an incoming playback update must satisfy:
     1. `hasScrobbled === true` (track already qualified for its first scrobble).
     2. `dropped >= threshold` (position dropped backwards by >= 50% of duration or >= 4 minutes).
     3. **Start Guard**: `newPosition <= 30` (the user actually rewound near the beginning of the track, within the first 30 seconds).
   - When conditions are met:
     - Close session for Play #1. Emits Play #1 as `prevPlay` with accurate completed duration and `playDateCompleted`.
     - Reset `hasScrobbled = false` and `hasEmittedCurrentPlay = false`.
     - Reset `playFirstSeenAt` to the current timestamp.
     - Clear `listenRanges`.
     - Begin Play #2 as a fresh listening session.
5. **Session End & Track Transitions**:
   - On track completion / switch: `prevPlay` emits with full listening duration (`listenedFor`) and `playDateCompleted`.
   - On stale player (pause > staleInterval): `cleanupPlayer` emits the in-progress play. If unpaused later and completed, `updateCompletedPlay` updates the existing database record without re-scrobbling.
   - Sub-50% skips are persisted as `state: 'discarded'`.

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
   - Calculating start time as `pa - duration` fails whenever the listener paused, seeked/rewound before 50%, or skipped after 50% (e.g. at 60%), causing timestamp drift of 60–120s and triggering false duplicate scrobbles.
   - **The Invariant**: A live play that scrobbled at 50% ended somewhere between its earliest valid completion offset (`listenedFor` for single-range plays, or `min(listenedFor, 30s)` for multi-range seeked/rewound plays) and $\max(T_{start} + \text{duration},\; \text{playDateCompleted},\; \text{pauseProjectedEnd})$, where `pauseProjectedEnd` uses positional remaining duration (`duration - lastRange.end.position`) when available.
   - To match a history item against an existing live play, check whether `pa` falls within:
     $$[\text{playDate} + \text{minCompletionOffset} - 30\text{s}, \;\; \max(\text{playDate} + \text{duration},\; \text{playDateCompleted},\; \text{pauseProjectedEnd}) + 30\text{s}]$$
   - This naturally accommodates pauses, pre-50% rewinds/loops, early skips (50%–99%), and normal completions.

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
  - Manages `hasScrobbled` (qualification & replay arming) and `hasEmittedCurrentPlay` state.
  - Accumulates `listenRanges` into duration-invariant `listenedFor`.
  - Evaluates `isPositionRewind` with both the threshold drop check AND the start guard (`newPosition <= 30`).
* **`MemorySource`**:
  - Emits candidate plays on session end (`prevPlay` on track transition or replay rewind; `cleanupPlay` on stale player) so clients receive accurate `listenedFor` and `playDateCompleted`.
  - When a track transitions without meeting threshold, persists it to the database with `state: 'discarded'`.
  - Updates previously emitted stale plays via `updateCompletedPlay` on later completion without duplicate scrobbles.
* **`PlayRepository`**:
  - Restricts duplicate search windows for live plays to strictly `[playedAt - 30s, playedAt + 30s]`.
  - For backlog queries, checks completion window matching against existing plays across all states (`scrobbled`, `discarded`).
* **`TimeUtils` & `PlayComparisonUtils`**:
  - Disables fuzzy duration matching for sequential plays.
  - Matches backlog candidates against live plays using completion-window comparison (anchoring `windowStart` at `playDate` on multi-range seeked/rewound plays and using positional remaining duration `duration - lastRange.end.position` for `projectedEnd`).
* **`SpotifySource`**:
  - Uses `timestamp - progress_ms` for exact live start timestamps.
  - Preserves completion timestamp `pa` for history items.
  - Adds a 2-minute safety grace buffer to the periodic reconcile job.

---

## 6. Verification Checklist for the Implementing Agent

1. **Session-End Scrobble with Full Duration**: Verify scrobbles emit at track end, replay rewind, or stale cleanup with accurate, full `listenedFor`, rather than truncated at 50%.
2. **Cumulative Listening**: Verify seeking backwards before 50% keeps accumulating listen time and qualifies once cumulative duration hits 50%, even if total duration exceeds 100%.
3. **Replays with Start Guard**:
   - Verify rewinding to 0:05 after 50% cleanly resets state and emits Play #1 with full duration, and Play #2 emits on its completion.
   - Verify rewinding from 8:00 to 3:30 on a 12-minute track does NOT trigger a replay.
4. **Deduplication**: Verify sequential replays of identical tracks are never flagged as duplicates.
5. **Early Skips & Pauses vs. Reconcile**: Verify pausing for 2 minutes or skipping at 60% does not cause duplicate scrobbles when the 15-minute history reconcile runs.
6. **Sub-50% Skips vs. Reconcile**: Verify skipping a track at 35 seconds records `state: 'discarded'` and is NOT resurrected by the 15-minute history reconcile.
7. **Spotify API Blackout Recovery**: Verify that if 3 tracks are completely missed by live tracking, the 15-minute history reconcile detects no existing DB record and successfully backfills all 3 tracks.
