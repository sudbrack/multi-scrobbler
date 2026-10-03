import { expect } from 'chai';
import { describe, it } from 'mocha';
import { comparePlayTemporally, timePassesScrobbleThreshold } from '../../utils/TimeUtils.ts';
import { DEFAULT_SCROBBLE_DURATION_THRESHOLD, DEFAULT_SCROBBLE_PERCENT_THRESHOLD } from '../../common/infrastructure/Atomic.ts';
import { SCROBBLE_TS_SOC_END, SCROBBLE_TS_SOC_START, TA_FUZZY, TA_NONE } from '../../../core/Atomic.ts';
import { generatePlay } from '../../../core/tests/utils/PlayTestUtils.ts';
import dayjs from 'dayjs';


describe('Scrobble Threshold Checks', function() {

    it('uses defaults when no user-configured thresholds are passed', function() {
        const results = timePassesScrobbleThreshold({}, 1, 1);
        expect(results.duration.threshold).to.eq(DEFAULT_SCROBBLE_DURATION_THRESHOLD);
        expect(results.percent.threshold).to.eq(DEFAULT_SCROBBLE_PERCENT_THRESHOLD);
    });

    it('uses user-configured thresholds when passed', function() {
        const results = timePassesScrobbleThreshold({
            duration: 20,
            percent: 15
        }, 1, 1);
        expect(results.duration.threshold).to.eq(20);
        expect(results.percent.threshold).to.eq(15);
    });

    it('passes when duration is above threshold', function() {
        const results = timePassesScrobbleThreshold({}, DEFAULT_SCROBBLE_DURATION_THRESHOLD + 1);
        expect(results.duration.passes).is.true;
        expect(results.passes).is.true;
    });

    it('passes when percent is above threshold', function() {
        const results = timePassesScrobbleThreshold({}, 30, 50);
        expect(results.percent.passes).is.true;
        expect(results.passes).is.true;
    });

    it('handles zero duration', function() {
        const results = timePassesScrobbleThreshold({}, DEFAULT_SCROBBLE_DURATION_THRESHOLD + 1, 0);
        expect(results.duration.passes).is.true;
        expect(results.passes).is.true;
    });
});

describe('comparePlayTemporally', function() {

    it('does not fuzzy match sequential repeat plays of the same track', function() {
        const play1 = generatePlay({
            track: 'Song A',
            duration: 180,
            playDate: dayjs('2026-10-01T12:00:00Z')
        }, {
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });

        // Replay starts 180s later (equal to duration)
        const play2 = generatePlay({
            track: 'Song A',
            duration: 180,
            playDate: dayjs('2026-10-01T12:03:00Z')
        }, {
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });

        const comparison = comparePlayTemporally(play1, play2);
        expect(comparison.match).to.eq(TA_NONE);
    });

    it('matches backlog play against live play via fuzzy duration diff', function() {
        // Live play started at 12:00:00
        const livePlay = generatePlay({
            track: 'Song A',
            duration: 180,
            playDate: dayjs('2026-10-01T12:00:00Z')
        }, {
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });

        // Backlog play reported with completion timestamp at 12:03:00 (180s later)
        const backlogPlay = generatePlay({
            track: 'Song A',
            duration: 180,
            playDate: dayjs('2026-10-01T12:03:00Z'),
            playDateCompleted: dayjs('2026-10-01T12:03:00Z')
        }, {
            scrobbleTsSOC: SCROBBLE_TS_SOC_END
        });

        const comparison = comparePlayTemporally(livePlay, backlogPlay);
        expect(comparison.match).to.eq(TA_FUZZY);
    });
});