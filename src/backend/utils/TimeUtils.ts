
import dayjs, { type Dayjs } from "dayjs";
//import isToday from 'dayjs/plugin/isToday.js';
import {
    type AcceptableTemporalDuringReference,
    PARSED_FROM,
    type PlayObject,
    SCROBBLE_TS_SOC_END,
    SCROBBLE_TS_SOC_START,
    type ScrobbleTsSOC,
    TA_CLOSE,
    TA_DEFAULT_ACCURACY,
    TA_DURING,
    TA_EXACT,
    TA_FUZZY,
    TA_NONE,
    type TemporalAccuracy,
    type TemporalPlayComparison,
    type UnixTimestamp,
} from "../../core/Atomic.ts";
import { capitalize, stringIsOnlyNumbers } from "../../core/StringUtils.ts";
import {
    DEFAULT_SCROBBLE_DURATION_THRESHOLD,
    DEFAULT_SCROBBLE_PERCENT_THRESHOLD,
    type DurationValue,
    lowGranularitySources,
    type ScrobbleThresholdResult,
} from "../common/infrastructure/Atomic.ts";
import type {ScrobbleThresholds} from "../common/infrastructure/config/source/index.ts";
import { formatNumber } from '../../core/DataUtils.ts';
import { InvalidRegexError, SimpleError } from "../common/errors/MSErrors.ts";
import { type NamedGroup, parseRegex } from "@foxxmd/regex-buddy-core";
import type {Duration} from "dayjs/plugin/duration.js";
import type {SourceType} from "../../core/Atomic.ts";
import type {Logger} from "@foxxmd/logging";
import { loggerNoop } from "../common/MaybeLogger.ts";

//dayjs.extend(isToday);

export const temporalPlayComparisonSummary = (data: TemporalPlayComparison, existingPlay?: PlayObject, candidatePlay?: PlayObject) => {
    const parts: string[] = [];
    const existingDate = existingPlay?.data.playDate;
    const candidateDate = candidatePlay?.data.playDate;
    if (existingDate !== undefined && candidateDate !== undefined) {
        if (existingDate.isSame(candidateDate, 'day')) {
            parts.push(`Existing: ${existingDate.format('HH:mm:ssZ')} - Candidate: ${candidateDate.format('HH:mm:ssZ')}`);
        } else {
            parts.push(`Existing: ${existingDate.toISOString()} - Candidate: ${candidateDate.toISOString()}`);
        }
    }
    parts.push(`Temporal Sameness: ${capitalize(temporalAccuracyToString(data.match))}`);
    if (data.date !== undefined) {
        parts.push(`Play Diff: ${formatNumber(data.date.diff, {toFixed: 0})}s (Needed <${data.date.threshold}s)`)
        if (data.date.fuzzyDurationDiff !== undefined) {
            parts.push(`Fuzzy Duration Diff: ${formatNumber(data.date.fuzzyDurationDiff, {toFixed: 0})}s (Needed <= ${data.date.fuzzyDiffThreshold}s)`);
        }
        if (data.date.fuzzyListenedDiff !== undefined) {
            parts.push(`Fuzzy Listened Diff: ${formatNumber(data.date.fuzzyListenedDiff, {toFixed: 0})}s (Needed <= ${data.date.fuzzyDiffThreshold}s)`);
        }
    }

    if(data.range === undefined) {
        parts.push('Range Comparison N/A');
    } else if(data.range.type === 'none') {
        parts.push(`Candidate not played during Existing ${data.duringReferences.join(' or ')}`);
    } else {
        parts.push(`Candidate played during tracked listening range from Existing "${data.range.type}" ${data.range.timestamps[0].format('HH:mm:ssZ')} => ${data.range.timestamps[1].format('HH:mm:ssZ')}`);
    }
    return parts.join(' | ');
}

export interface TemporalPlayComparisonOptions {
    diffThreshold?: number,
    fuzzyDuration?: boolean,
    fuzzyDiffThreshold?: number
    duringReferences?: AcceptableTemporalDuringReference
    logger?: Logger
}

export const comparePlayTemporally = (existingPlay: PlayObject, candidatePlay: PlayObject, options: TemporalPlayComparisonOptions = {}): TemporalPlayComparison => {


    const {
        meta: {
            source,
            //scrobbleTsSOC: existingScrobbleTsSOC = SCROBBLE_TS_SOC_START,
        },
        data: {
            // playDate: existingPlayDate,
            // playDateCompleted: existingPlayDateCompleted,
            duration: existingDuration,
            listenRanges: existingRanges,
            listenedFor: existingListenedFor,
        }
    } = existingPlay;

    const [existingTsSOCDate] = getScrobbleTsSOCDateWithContext(existingPlay);

    const {
        data: {
            duration: newDuration,
            listenedFor: newListenedFor,
        }
    } = candidatePlay;

    const [candidateTsSOCDate] = getScrobbleTsSOCDateWithContext(candidatePlay);

    const candidateIsLive = candidatePlay.meta.parsedFrom === PARSED_FROM.player
        || candidatePlay.meta.newFromSource === true
        || (candidatePlay.data.listenRanges !== undefined && candidatePlay.data.listenRanges.length > 0);
    const existingIsLive = existingPlay.meta.parsedFrom === PARSED_FROM.player
        || existingPlay.meta.newFromSource === true
        || (existingPlay.data.listenRanges !== undefined && existingPlay.data.listenRanges.length > 0);
    const candidateIsBacklogOrHistory = !candidateIsLive && (
        candidatePlay.meta.parsedFrom === PARSED_FROM.backlog
        || candidatePlay.meta.parsedFrom === PARSED_FROM.history
        || candidatePlay.meta.scrobbleTsSOC === SCROBBLE_TS_SOC_END
    );

    const {
        diffThreshold = getTemporalAccuracyCloseVal(source as SourceType),
        fuzzyDuration = false,
        fuzzyDiffThreshold = 10,
        duringReferences = candidateIsLive ? [] : (candidateIsBacklogOrHistory ? ['range', 'listenedFor', 'duration'] : ['range']),
        logger = loggerNoop
    } = options;

    const result: TemporalPlayComparison = {
        match: TA_NONE,
        duringReferences
    };

    const existingCompareDate = (candidateIsLive && existingIsLive && existingPlay.data.playDate !== undefined)
        ? existingPlay.data.playDate
        : existingTsSOCDate;
    const candidateCompareDate = (candidateIsLive && existingIsLive && candidatePlay.data.playDate !== undefined)
        ? candidatePlay.data.playDate
        : candidateTsSOCDate;

    // cant compare!
    if (existingCompareDate === undefined || candidateCompareDate === undefined) {
        return result;
    }

    const referenceDuration = newDuration ?? existingDuration;
    const referenceListenedFor = newListenedFor ?? existingListenedFor;

    const playDiffThreshold = diffThreshold;

    // check if existing play time is same as new play date
    const scrobblePlayDiff = Math.abs(existingCompareDate.unix() - candidateCompareDate.unix());
    result.date = {
        threshold: diffThreshold,
        diff: scrobblePlayDiff,
        fuzzyDiffThreshold
    };

    if(scrobblePlayDiff <= 1) {
        result.match = TA_EXACT;
    } else if (scrobblePlayDiff <= playDiffThreshold) {
        result.match = TA_CLOSE;
    }

    if(result.match !== TA_NONE) {
        return result;
    }

    if(duringReferences.length > 0) {
        // NOTE: completion window anchors on existingPlay.data.playDate directly,
        // NOT existingTsSOCDate -- existingTsSOCDate can resolve to playDateCompleted instead of
        // playDate depending on the play's scrobbleTsSOC.
        // Completion window: [playDate + listenedFor - 30s, max(playDate + duration, playDateCompleted, pauseProjectedEnd) + 30s]
        const existingPlayDate = existingPlay.data.playDate;
        if (
            existingPlayDate !== undefined
            && (duringReferences.includes('duration') || duringReferences.includes('listenedFor'))
            && (existingPlay.data.duration !== undefined || existingPlay.data.listenedFor !== undefined)
        ) {
            const listenedOffset = existingPlay.data.listenedFor ?? 0;
            const windowStart = existingPlayDate.add(listenedOffset, 's').subtract(30, 's');

            let baseEnd = existingPlayDate.add(Math.max(existingPlay.data.duration ?? 0, listenedOffset), 's');
            if (existingPlay.data.playDateCompleted !== undefined && existingPlay.data.playDateCompleted.isAfter(baseEnd)) {
                baseEnd = existingPlay.data.playDateCompleted;
            }
            try {
                if (existingRanges !== undefined && existingRanges.length > 0) {
                    const lastRangeEnd = existingRanges[existingRanges.length - 1].end.timestamp;
                    const remainingDuration = Math.max(0, (existingPlay.data.duration ?? 0) - listenedOffset);
                    const projectedEnd = lastRangeEnd.add(remainingDuration, 's');
                    if (projectedEnd.isAfter(baseEnd)) {
                        baseEnd = projectedEnd;
                    }
                }
            } catch (e) {
                logger.warn(new Error('Failed to compute projected range end', {cause: e}));
            }
            const windowEnd = baseEnd.add(30, 's');

            if (candidateTsSOCDate.isBetween(windowStart, windowEnd, undefined, '[]')) {
                result.match = TA_DURING;
                result.range = {
                    type: existingPlay.data.duration !== undefined && duringReferences.includes('duration') ? 'duration' : 'listenedFor',
                    timestamps: [windowStart, windowEnd]
                };
                return result;
            }
        } else {
            // guard against old, badly cached/marshalled range data:
            // this should not be an issue in 0.14.0+ since listenprogress has been updated to be a plain object
            // but for folks migrating with very old cached data it could end up being an issue
            try {
                if (duringReferences.includes('range') && existingRanges !== undefined) {
                    for (const range of existingRanges) {
                        if (candidateTsSOCDate.isBetween(range.start.timestamp, range.end.timestamp)) {
                            result.range = {
                                type: 'range',
                                timestamps: [range.start.timestamp, range.end.timestamp]
                            };
                            result.match = TA_DURING;
                            return result;
                        }
                    }
                }
            } catch (e) {
                logger.warn(new Error('Failed to compare plays based on range but will continue', {cause: e}));
            }
        }
    }

    // Fuzzy duration matching is disabled for sequential plays unless explicitly requested via fuzzyDuration
    if (result.match === TA_NONE && referenceDuration !== undefined && fuzzyDuration) {
        result.date.fuzzyDurationDiff = Math.abs(scrobblePlayDiff - referenceDuration);
        if (result.date.fuzzyDurationDiff <= fuzzyDiffThreshold) {
            result.match = TA_FUZZY;
        }
    }
    if (result.match === TA_NONE && referenceListenedFor !== undefined && fuzzyDuration) {
        result.date.fuzzyListenedDiff = Math.abs(scrobblePlayDiff - referenceListenedFor);
        if (result.date.fuzzyListenedDiff <= fuzzyDiffThreshold) {
            result.match = TA_FUZZY;
        }
    }

    return result;
}
export const timePassesScrobbleThreshold = (thresholds: ScrobbleThresholds, secondsTracked: number, playDuration?: number): ScrobbleThresholdResult => {
    let durationPasses = undefined,
        percentPasses = undefined,
        percent: number | undefined;

    const durationThreshold: number | null = thresholds.duration ?? DEFAULT_SCROBBLE_DURATION_THRESHOLD,
        percentThreshold: number | null = thresholds.percent ?? DEFAULT_SCROBBLE_PERCENT_THRESHOLD;


    if (percentThreshold !== null && playDuration !== undefined && playDuration !== 0) {
        percent = Math.round(((secondsTracked / playDuration) * 100));
        percentPasses = percent >= percentThreshold;
    }
    if (durationThreshold !== null || percentPasses === undefined) {
        durationPasses = secondsTracked >= durationThreshold;
    }

    return {
        passes: (durationPasses ?? false) || (percentPasses ?? false),
        duration: {
            passes: durationPasses,
            threshold: durationThreshold,
            value: secondsTracked
        },
        percent: {
            passes: percentPasses,
            value: percent,
            threshold: percentThreshold
        }
    }
}

export const hasAcceptableTemporalAccuracy = (found: TemporalAccuracy, expected: TemporalAccuracy[] = TA_DEFAULT_ACCURACY): boolean => expected.includes(found);

export const temporalAccuracyToString = (acc: TemporalAccuracy): string => {
    switch(acc) {
        case 1:
            return 'exact';
        case 2:
            return 'close';
        case 3:
            return 'fuzzy';
        case 4:
            return 'during';
        case 99:
            return 'no correlation';
    }
}

export const getTemporalAccuracyCloseVal = (source: SourceType): number => {
    return lowGranularitySources.includes(source) ? 60 : 10;
}

export const getScrobbleTsSOCDateWithContext = (data: PlayObject): [Dayjs, ScrobbleTsSOC] => {
    const {
        meta: {
            scrobbleTsSOC = SCROBBLE_TS_SOC_START,
        },
        data: {
            playDate = dayjs(),
            playDateCompleted
        }
    } = data;

    if(scrobbleTsSOC === SCROBBLE_TS_SOC_END && playDateCompleted !== undefined) {
        return [playDateCompleted, SCROBBLE_TS_SOC_END];
    }
    return [playDate, SCROBBLE_TS_SOC_START];
}

export const getScrobbleTsSOCDate = (data: PlayObject): Dayjs => {
    const [date, _] = getScrobbleTsSOCDateWithContext(data);
    return date;
}

export const parseDurationFromTimestamp = (timestamp: any) => {
    if (timestamp === null || timestamp === undefined) {
        return undefined;
    }
    if (!(typeof timestamp === 'string')) {
        throw new Error('Timestamp must be a string');
    }
    if (timestamp.trim() === '') {
        return undefined;
    }
    const parsedRuntime = timestamp.split(':');
    let hours = '0', minutes = '0', seconds = '0', milli = '0';

    switch (parsedRuntime.length) {
        case 3:
            hours = parsedRuntime[0];
            minutes = parsedRuntime[1];
            seconds = parsedRuntime[2];
            break;
        case 2:
            minutes = parsedRuntime[0];
            seconds = parsedRuntime[1];
            break;
        case 1:
            seconds = parsedRuntime[0];
    }
    const splitSec = seconds.split('.');
    if (splitSec.length > 1) {
        seconds = splitSec[0];
        milli = splitSec[1];
    }
    return dayjs.duration({
        hours: Number.parseInt(hours),
        minutes: Number.parseInt(minutes),
        seconds: Number.parseInt(seconds),
        milliseconds: Number.parseInt(milli)
    });
};

/** Convert unix timestamp in microseconds to unix timestamp in seconds */
export const usecToUnix = (usec: number): UnixTimestamp => {
    return Math.floor(usec / 1000);
}

// string must only contain ISO8601 optionally wrapped by whitespace
const ISO8601_REGEX: RegExp = /^\s*((-?)P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)([DW]))?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?)\s*$/;
// finds ISO8601 in any part of a string
const ISO8601_SUBSTRING_REGEX: RegExp = /((-?)P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)([DW]))?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?)/g;
// string must only duration optionally wrapped by whitespace
const DURATION_REGEX: RegExp = /^\s*(?<time>\d+)\s*(?<unit>days?|weeks?|months?|years?|hours?|minutes?|seconds?|milliseconds?)\s*$/;
// finds duration in any part of the string
const DURATION_SUBSTRING_REGEX: RegExp = /(?<time>\d+)\s*(?<unit>days?|weeks?|months?|years?|hours?|minutes?|seconds?|milliseconds?)/g;

export const parseDurationFromString = (val: string, strict = true): {duration: Duration, original: string}[] => {
    let matches = parseRegex(strict ? DURATION_REGEX : DURATION_SUBSTRING_REGEX, val);
    if (matches !== undefined) {
        return matches.map(x => {
            const groups = x.named as NamedGroup;
            const dur: Duration = dayjs.duration(groups.time, groups.unit);
            if (!dayjs.isDuration(dur)) {
                throw new SimpleError(`Parsed value '${x.match}' did not result in a valid Dayjs Duration`);
            }
            return {duration: dur, original: `${groups.time} ${groups.unit}`};
        });
    }

    matches = parseRegex(strict ? ISO8601_REGEX : ISO8601_SUBSTRING_REGEX, val);
    if (matches !== undefined) {
        return matches.map(x => {
            const dur: Duration = dayjs.duration(x.groups[0]);
            if (!dayjs.isDuration(dur)) {
                throw new SimpleError(`Parsed value '${x.groups[0]}' did not result in a valid Dayjs Duration`);
            }
            return {duration: dur, original: x.groups[0]};
        });
    }

    throw new InvalidRegexError([(strict ? DURATION_REGEX : DURATION_SUBSTRING_REGEX), (strict ? ISO8601_REGEX : ISO8601_SUBSTRING_REGEX)], val)
}

export const parseDuration = (val: string, strict = true): Duration => {
    const res = parseDurationFromString(val, strict);
    if(res.length > 1) {
        throw new SimpleError(`Must only have one Duration value, found ${res.length} in: ${val}`);
    }
    return res[0].duration;
}

export const parseDurationFromDurationValue = (val: DurationValue): Duration => {
    if(typeof val === 'number') {
        return dayjs.duration(val, 'seconds');
    }
    if(stringIsOnlyNumbers(val) && !isNaN(Number.parseInt(val))) {
        return dayjs.duration(Number.parseInt(val), 'seconds');
    }

    return parseDuration(val, true);
}