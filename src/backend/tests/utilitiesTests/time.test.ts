import { expect } from 'chai';
import { describe, it } from 'mocha';
import dayjs from 'dayjs';
import { comparePlayTemporally, timePassesScrobbleThreshold } from '../../utils/TimeUtils.ts';
import { DEFAULT_SCROBBLE_DURATION_THRESHOLD, DEFAULT_SCROBBLE_PERCENT_THRESHOLD } from '../../common/infrastructure/Atomic.ts';
import { PARSED_FROM, SCROBBLE_TS_SOC_END, SCROBBLE_TS_SOC_START, TA_DURING, TA_EXACT, TA_FUZZY, TA_NONE } from '../../../core/Atomic.ts';
import { generatePlay } from '../../../core/tests/utils/PlayTestUtils.ts';

describe('Temporal Play Comparison', function() {

    it('does not fuzzy match consecutive live plays spaced by track duration by default', function() {
        const start = dayjs();
        const firstPlay = generatePlay({
            playDate: start,
            duration: 180,
            listenedFor: 90
        }, {
            parsedFrom: PARSED_FROM.player,
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });
        const secondPlay = generatePlay({
            playDate: start.add(180, 'seconds'),
            duration: 180,
            listenedFor: 90
        }, {
            parsedFrom: PARSED_FROM.player,
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });

        const result = comparePlayTemporally(firstPlay, secondPlay);
        expect(result.match).to.eq(TA_NONE);
    });

    it('allows fuzzy duration match only when fuzzyDuration option is explicitly true', function() {
        const start = dayjs();
        const firstPlay = generatePlay({
            playDate: start,
            duration: 180
        });
        const secondPlay = generatePlay({
            playDate: start.add(180, 'seconds'),
            duration: 180
        });

        expect(comparePlayTemporally(firstPlay, secondPlay).match).to.eq(TA_NONE);
        expect(comparePlayTemporally(firstPlay, secondPlay, { fuzzyDuration: true }).match).to.eq(TA_FUZZY);
    });

    it('matches backlog completion timestamp within live play completion window', function() {
        const start = dayjs();
        const livePlay = generatePlay({
            playDate: start,
            duration: 200,
            listenedFor: 100
        }, {
            parsedFrom: PARSED_FROM.player,
            scrobbleTsSOC: SCROBBLE_TS_SOC_START
        });
        // User skipped at 60% (120s after start) -> Spotify history reports completion at start + 120s
        const historyPlay = generatePlay({
            playDate: start.add(120, 'seconds'),
            playDateCompleted: start.add(120, 'seconds'),
            duration: 200
        }, {
            parsedFrom: PARSED_FROM.backlog,
            scrobbleTsSOC: SCROBBLE_TS_SOC_END
        });

        const result = comparePlayTemporally(livePlay, historyPlay);
        expect(result.match).to.be.oneOf([TA_EXACT, TA_DURING]);
    });
});

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