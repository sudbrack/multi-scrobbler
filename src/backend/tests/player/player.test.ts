import { loggerTest } from "@foxxmd/logging";
import { assert, expect } from 'chai';
import clone from "clone";
import dayjs, { type Dayjs } from "dayjs";
import { describe, it } from 'mocha';
import {
    type PlayerStateDataMaybePlay} from "../../common/infrastructure/Atomic.ts";
import { SINGLE_USER_PLATFORM_ID } from '../../../core/Atomic.ts';
import { NO_USER } from '../../../core/Atomic.ts';
import { NO_DEVICE } from '../../../core/Atomic.ts';
import { CALCULATED_PLAYER_STATUSES } from '../../../core/Atomic.ts';
import { REPORTED_PLAYER_STATUSES } from '../../../core/Atomic.ts';
import { GenericPlayerState } from "../../sources/PlayerState/GenericPlayerState.ts";
import { playObjDataMatch } from "../../utils.ts";
import { generatePlay } from "../../../core/tests/utils/PlayTestUtils.ts";
import { PositionalPlayerState } from "../../sources/PlayerState/PositionalPlayerState.ts";
import type { ListenProgressPositional } from "../../sources/PlayerState/ListenProgress.ts";
import type { ListenRangePositional } from "../../sources/PlayerState/ListenRange.ts";
import { timePassesScrobbleThreshold } from "../../utils/TimeUtils.ts";

const logger = loggerTest;

const newPlay = generatePlay({duration: 300});

const testState = (data: Omit<PlayerStateDataMaybePlay, 'platformId'>): PlayerStateDataMaybePlay => ({...data, platformId: SINGLE_USER_PLATFORM_ID});

class TestPositionalPlayerState extends PositionalPlayerState {
    protected newListenRange(start: ListenProgressPositional, end?: ListenProgressPositional, options: object = {}): ListenRangePositional {
        const range = super.newListenRange(start, end, {allowedDrift: this.allowedDrift, rtImmediate: false, rtTruth: this.rtTruth, ...options});
        return range;
    }
    public testPositionRewind(position: number) {
        return this.isPositionRewind(position);
    }
}

describe('Basic player state', function () {

    it('Creates new play state when new', function () {
        const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

        assert.isUndefined(player.currentListenRange);
        assert.isUndefined(player.currentPlay);

        player.update(testState({play: newPlay}));

        assert.isDefined(player.currentListenRange);
        assert.isDefined(player.currentPlay);
    });

    it('Creates new play state in unknown status', function () {
        const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

        assert.isUndefined(player.currentListenRange);
        assert.isUndefined(player.currentPlay);

        player.update(testState({play: newPlay}));

        assert.isDefined(player.currentListenRange);
        assert.isDefined(player.currentPlay);
        assert.equal(CALCULATED_PLAYER_STATUSES.unknown, player.calculatedStatus);
    });

    it('Creates new play state when incoming play is not the same as stored play', function () {
        const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

        player.update(testState({play: newPlay}));

        assert.isTrue(playObjDataMatch(player.currentPlay!, newPlay));

        const nextPlay = generatePlay({playDate: newPlay.data.playDate!.add(2, 'seconds')});
        const [returnedPlay, prevPlay] = player.update(testState({play: nextPlay}));

        assert.isTrue(playObjDataMatch(prevPlay!, newPlay));
        assert.isTrue(playObjDataMatch(player.currentPlay!, nextPlay));
    });
});

describe('Player status', function () {

    it('New player transitions from unknown to playing on n+1 states', function () {
        const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

        player.update(testState({play: newPlay}));
        assert.equal(CALCULATED_PLAYER_STATUSES.unknown, player.calculatedStatus);

        player.update(testState({play: newPlay}), dayjs().add(10, 'seconds'));
        assert.equal(CALCULATED_PLAYER_STATUSES.playing, player.calculatedStatus);
    });

    describe('When source provides reported status', function () {

        it('Calculated state is playing when source reports playing', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            assert.equal(CALCULATED_PLAYER_STATUSES.playing, player.calculatedStatus);
        });


        it('Calculated state is paused when source reports paused', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.paused}), dayjs().add(20, 'seconds'));
            assert.equal(CALCULATED_PLAYER_STATUSES.paused, player.calculatedStatus);
        });

        it('Calculated state is stopped when source reports stopped', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.stopped}), dayjs().add(20, 'seconds'));
            assert.equal(CALCULATED_PLAYER_STATUSES.stopped, player.calculatedStatus);
        });

    });

    describe('When source provides playback position', function () {

        it('Calculated state is playing when position moves forward', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);

            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(13000);
            player.update(testState({play: positioned, position: 13}), dayjs().add(10, 'seconds'));

            assert.equal(CALCULATED_PLAYER_STATUSES.playing, player.calculatedStatus);
        });

        it('Calculated state is paused when position does not change and rt overdrifts', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);
            positioned.meta.trackProgressPosition = 3;

            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(13000);
            player.update(testState({play: positioned, position: 13}), dayjs().add(10, 'seconds'));

            player.currentListenRange!.rtPlayer.setPosition(23000);
            player.update(testState({play: positioned, position: 13}), dayjs().add(20, 'seconds'));

            assert.equal(CALCULATED_PLAYER_STATUSES.paused, player.calculatedStatus);
        });

        it('Uses last known position for final range when cleaning up stale player', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER], {staleInterval: 20, rtTruth: true});

            const positioned = clone(newPlay);
            positioned.meta.trackProgressPosition = 3;

            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(13000);
            player.update(testState({play: positioned, position: 13}), dayjs().add(10, 'seconds'));

            player.currentListenRange!.rtPlayer.setPosition(23000);
            player.update(testState({play: positioned, position: 23}), dayjs().add(20, 'seconds'));

            const staleDate = dayjs().add(41, 'seconds')
            player.currentListenRange!.rtPlayer.setPosition(44000);
            expect(player.currentListenRange!.isOverDrifted(23)).to.be.true;

            expect(player.checkStale(staleDate)).to.be.true;
            expect(player.listenRanges[player.listenRanges.length - 1].end.position).to.eq(23);
            expect(player.getListenDuration()).to.eq(20);
        });

        // TODO playback position reported and conflicts with player reported status
    });
});

describe('Player listen ranges', function () {
    describe('When source does not provide playback position', function () {

        it('Duration is timestamp based for unknown/playing reported players', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(20, 'seconds'));

            assert.equal(player.getListenDuration(), 20);

            const uplayer = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            uplayer.update(testState({play: newPlay}));
            uplayer.update(testState({play: newPlay}), dayjs().add(10, 'seconds'));
            uplayer.update(testState({play: newPlay}), dayjs().add(20, 'seconds'));

            assert.equal(uplayer.getListenDuration(), 20);
        });

        it('Range ends if player reports paused', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(20, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.paused}), dayjs().add(30, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.paused}), dayjs().add(40, 'seconds'));

            assert.equal(player.getListenDuration(), 20);
        });

        it('Listen duration continues when player resumes', function () {
            const player = new GenericPlayerState(logger, [NO_DEVICE, NO_USER]);

            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(20, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.paused}), dayjs().add(30, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.paused}), dayjs().add(40, 'seconds'));
            // For TS-only players the player must see two consecutive playing states to count the duration between them
            // so it does NOT count above paused ^^ to below playing -- only playing-to-playing
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(50, 'seconds'));
            player.update(testState({play: newPlay, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(60, 'seconds'));

            assert.equal(player.getListenDuration(), 30);
        });
    });

    describe('When source does provide playback position', function () {

        it('Listened duration is position based', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);

            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(10000);
            player.update(testState({play: positioned, position: 10}), dayjs().add(10, 'seconds'));

            assert.equal(player.getListenDuration(), 7);
        });

        it('Listened duration is track duration invariant', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);
            positioned.data.duration = 0;

            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(10000);
            player.update(testState({play: positioned, position: 10}), dayjs().add(10, 'seconds'));

            assert.equal(player.getListenDuration(), 7);
        });

        it('Listened for is track duration invariant', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);
            positioned.data.duration = 0;

            player.update(testState({play: positioned, position: 3, status: REPORTED_PLAYER_STATUSES.playing}));

            player.currentListenRange!.rtPlayer.setPosition(10000);
            player.update(testState({play: positioned, position: 10, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(10, 'seconds'));

            player.currentListenRange!.rtPlayer.setPosition(20000);
            player.update(testState({play: positioned, position: 20, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(20, 'seconds'));

            const otherPlay = clone(positioned);
            otherPlay.data.track = "A New Track";
            player.currentListenRange!.rtPlayer.setPosition(30000);
            const [currPlay, prevPlay] = player.update(testState({play: otherPlay, position: 2, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(30, 'seconds'));

            assert.isDefined(prevPlay);
            assert.equal(prevPlay.data.listenedFor, 17);
        });

        it('Range ends if position over drifts', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);
            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(10000);
            player.update(testState({play: positioned, position: 3}), dayjs().add(10, 'seconds'));

            assert.equal(player.getListenDuration(), 0);
        });

        it('Range continues when position continues moving forward', function () {
            const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

            const positioned = clone(newPlay);
            player.update(testState({play: positioned, position: 3}));

            player.currentListenRange!.rtPlayer.setPosition(7000);
            player.update(testState({play: positioned, position: 7}), dayjs().add(4, 'seconds'));


            player.currentListenRange!.rtPlayer.setPosition(23000);
            player.update(testState({play: positioned, position: 23}), dayjs().add(20, 'seconds'));

            player.currentListenRange!.rtPlayer.setPosition(33000);
            player.update(testState({play: positioned, position: 33}), dayjs().add(30, 'seconds'));

            player.currentListenRange!.rtPlayer.setPosition(43000);
            player.update(testState({play: positioned, position: 43}), dayjs().add(40, 'seconds'));

            assert.equal(player.getListenDuration(), 40);
        });

        describe('Detects seeking', function () {

            it('Detects seeking forward', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

                const positioned = clone(newPlay);
                player.update(testState({play: positioned, position: 3}));

                positioned.meta.trackProgressPosition = 13;
                player.currentListenRange!.rtPlayer.setPosition(13000);
                player.update(testState({play: positioned, position: 13}), dayjs().add(10, 'seconds'));

                player.currentListenRange!.rtPlayer.setPosition(17000);
                const [isSeeked, time] = player.currentListenRange!.seeked(24, dayjs().add(17, 'seconds'))
                assert.isTrue(isSeeked);
                assert.equal(time, 7000)
            });

            it('Detects seeking backwards when position is before last reported position', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

                const positioned = clone(newPlay);
                player.update(testState({play: positioned, position: 3}));

                player.currentListenRange!.rtPlayer.setPosition(13000);
                player.update(testState({play: positioned, position: 13}), dayjs().add(10, 'seconds'));

                player.currentListenRange!.rtPlayer.setPosition(17000);
                const [isSeeked, time] = player.currentListenRange!.seeked(10, dayjs().add(17, 'seconds'))
                assert.isTrue(isSeeked);
                assert.equal(time, -3000)
            });
        });

        describe('Detects repeating and 50% scrobble threshold', function () {
            it('scrobbles immediately when reaching 50% of duration', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);
                const track = clone(newPlay);
                track.data.duration = 300;

                // Start at position 0
                player.update(testState({play: track, position: 0, status: REPORTED_PLAYER_STATUSES.playing}));

                // Advance to 100s (< 50%)
                player.currentListenRange!.rtPlayer.setPosition(100000);
                const [, scrobble1] = player.update(testState({play: track, position: 100, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(100, 'seconds'));
                assert.isUndefined(scrobble1, 'Should not scrobble before 50%');
                assert.isFalse(player.hasScrobbled);

                // Advance to 150s (50%)
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobble2] = player.update(testState({play: track, position: 150, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(150, 'seconds'));
                assert.isDefined(scrobble2, 'Should scrobble immediately at 50%');
                assert.isTrue(player.hasScrobbled);
                assert.equal(scrobble2!.data.listenedFor, 150);
            });

            it('preserves exact start playDate from play object when scrobbled', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);
                const exactStart = dayjs('2026-10-01T11:59:30Z');
                const track = generatePlay({
                    duration: 300,
                    playDate: exactStart
                });

                // First polled at position 0
                player.update(testState({play: track, position: 0, status: REPORTED_PLAYER_STATUSES.playing}));

                // Reaches 50% (150s)
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobble] = player.update(testState({play: track, position: 150, status: REPORTED_PLAYER_STATUSES.playing}));
                assert.isDefined(scrobble);
                assert.equal(scrobble!.data.playDate!.toISOString(), exactStart.toISOString());
            });

            it('resets session and scrobbles second play when rewound after 50%', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);
                const track = clone(newPlay);
                track.data.duration = 300;

                // Start at 0
                player.update(testState({play: track, position: 0, status: REPORTED_PLAYER_STATUSES.playing}));

                // Advance to 150s (scrobble #1)
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobble1] = player.update(testState({play: track, position: 150, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(150, 'seconds'));
                assert.isDefined(scrobble1);
                assert.isTrue(player.hasScrobbled);

                // Advance to 260s
                player.currentListenRange!.rtPlayer.setPosition(260000);
                const [, betweenScrobble] = player.update(testState({play: track, position: 260, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(260, 'seconds'));
                assert.isUndefined(betweenScrobble);

                // Rewind back to 0:05 (dropped 255s >= 50%)
                player.currentListenRange!.rtPlayer.setPosition(261000);
                const [, prevRewind] = player.update(testState({play: track, position: 5, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(261, 'seconds'));
                assert.isUndefined(prevRewind, 'Rewind resets session and does not emit old play again');
                assert.isFalse(player.hasScrobbled, 'hasScrobbled should be reset to false for play #2');
                assert.isTrue(player.isRepeatPlay, 'Should be flagged as repeat play');
                assert.equal(player.getListenDuration(), 0, 'Listen duration should be reset to 0');

                // Advance play #2 to 155s (150s listened from 5s)
                player.currentListenRange!.rtPlayer.setPosition(155000);
                const [, scrobble2] = player.update(testState({play: track, position: 155, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(411, 'seconds'));
                assert.isDefined(scrobble2, 'Play #2 should scrobble when it reaches 50%');
                assert.isTrue(player.hasScrobbled);
                assert.isTrue(scrobble2!.data.repeat);
            });

            it('does not double-scrobble when track finishes after being scrobbled at 50%', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);
                const track = clone(newPlay);
                track.data.duration = 300;

                // Start
                player.update(testState({play: track, position: 0, status: REPORTED_PLAYER_STATUSES.playing}));

                // Reach 50%
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobble1] = player.update(testState({play: track, position: 150, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(150, 'seconds'));
                assert.isDefined(scrobble1);

                // Continue to near end (290s)
                player.currentListenRange!.rtPlayer.setPosition(290000);
                const [, progress] = player.update(testState({play: track, position: 290, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(290, 'seconds'));
                assert.isUndefined(progress);

                // Transition to next track
                const track2 = generatePlay({duration: 200});
                track2.data.track = "Second Track";
                player.currentListenRange!.rtPlayer.setPosition(300000);
                const [, onTransition] = player.update(testState({play: track2, position: 0, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(300, 'seconds'));
                assert.isUndefined(onTransition, 'Must not re-emit track on transition if already scrobbled at 50%');
            });

            it('handles rapid track switch (Song A -> Song B for 3s -> Song A) as two distinct plays of Song A', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);
                const songA = clone(newPlay);
                songA.data.track = "Song A";
                songA.data.duration = 300;

                const songB = clone(newPlay);
                songB.data.track = "Song B";
                songB.data.duration = 200;

                // Song A starts at T=0
                player.update(testState({play: songA, position: 0, status: REPORTED_PLAYER_STATUSES.playing}), dayjs('2026-10-01T12:00:00Z'));

                // Song A reaches 50% at T=150s -> scrobbles Play #1
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobbleA1] = player.update(testState({play: songA, position: 150, status: REPORTED_PLAYER_STATUSES.playing}), dayjs('2026-10-01T12:02:30Z'));
                assert.isDefined(scrobbleA1);
                assert.equal(scrobbleA1!.data.track, "Song A");

                // User skips to Song B at T=200s
                player.currentListenRange!.rtPlayer.setPosition(200000);
                const [, onSongBStart] = player.update(testState({play: songB, position: 0, status: REPORTED_PLAYER_STATUSES.playing}), dayjs('2026-10-01T12:03:20Z'));
                assert.isUndefined(onSongBStart, 'Song A was already scrobbled');
                assert.isFalse(player.hasScrobbled);

                // After 3 seconds (T=203s), user clicks back to Song A
                player.currentListenRange!.rtPlayer.setPosition(3000);
                const [, onBackToA] = player.update(testState({play: songA, position: 0, status: REPORTED_PLAYER_STATUSES.playing}), dayjs('2026-10-01T12:03:23Z'));
                assert.isDefined(onBackToA);
                assert.equal(onBackToA!.data.track, 'Song B');
                assert.isFalse(timePassesScrobbleThreshold({}, onBackToA!.data.listenedFor ?? 0, onBackToA!.data.duration).passes, 'Song B had not reached 50% and is discarded by MemorySource');
                assert.isFalse(player.hasScrobbled, 'Song A play #2 starts fresh');
                assert.equal(player.getListenDuration(), 0);

                // Song A play #2 reaches 50% (position 150s, T=353s)
                player.currentListenRange!.rtPlayer.setPosition(150000);
                const [, scrobbleA2] = player.update(testState({play: songA, position: 150, status: REPORTED_PLAYER_STATUSES.playing}), dayjs('2026-10-01T12:05:53Z'));
                assert.isDefined(scrobbleA2, 'Song A play #2 scrobbles at 50%');
                assert.equal(scrobbleA2!.data.track, "Song A");
                // Verify start timestamps are distinct (> 30s apart)
                assert.isTrue(scrobbleA2!.data.playDate!.diff(scrobbleA1!.data.playDate!, 'seconds') > 30);
            });

            it('Resets repeat status when updated with non-matching play', function () {
                const player = new TestPositionalPlayerState(logger, [NO_DEVICE, NO_USER]);

                const positioned = clone(newPlay);
                positioned.data.duration = 70;

                player.update(testState({play: positioned, position: 0, status: REPORTED_PLAYER_STATUSES.playing}));

                // Reach 50%+ (40s)
                player.currentListenRange!.rtPlayer.setPosition(40000);
                player.update(testState({play: positioned, position: 40, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(40, 'seconds'));

                // Rewind to 2s (dropped 38s >= 50%)
                player.currentListenRange!.rtPlayer.setPosition(41000);
                const [curr] = player.update(testState({play: positioned, position: 2, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(41, 'seconds'));

                assert.isTrue(curr!.data.repeat);
                assert.isTrue(player.isRepeatPlay);

                // Update with non-matching play
                player.currentListenRange!.rtPlayer.setPosition(45000);
                const [currNew, prevPlayRepeat] = player.update(testState({play: generatePlay(), position: 1, status: REPORTED_PLAYER_STATUSES.playing}), dayjs().add(45, 'seconds'));

                assert.isDefined(prevPlayRepeat);
                assert.isTrue(prevPlayRepeat.data.repeat);
                assert.isDefined(currNew);
                assert.isFalse(currNew.data.repeat);
            });
        });
    });
});
