import { childLogger, type Logger } from "@foxxmd/logging";
import dayjs, { type Dayjs } from "dayjs";
import { type PlayObject, type PlayProgress, type Second, SOURCE_SOT, type SOURCE_SOT_TYPES, type SourcePlayerObj } from "../../../core/Atomic.ts";
import { buildTrackString } from "../../../core/StringUtils.ts";
import {
    asPlayerStateData,
    type PlayerStateData,
    type PlayerStateDataMaybePlay,
} from "../../common/infrastructure/Atomic.ts";
import { CALCULATED_PLAYER_STATUSES } from '../../../core/Atomic.ts';
import type {CalculatedPlayerStatus} from '../../../core/Atomic.ts';
import { REPORTED_PLAYER_STATUSES } from '../../../core/Atomic.ts';
import type {ReportedPlayerStatus} from '../../../core/Atomic.ts';
import type {PlayPlatformId} from '../../../core/Atomic.ts';
import type {PollingOptions} from "../../common/infrastructure/config/common.ts";
import { playObjDataMatch, progressBar } from "../../utils.ts";
import { genGroupIdStr } from '../../../core/PlayUtils.ts';
import { formatNumber } from '../../../core/DataUtils.ts';
import type {ListenProgress} from "./ListenProgress.ts";
import type { ListenRange} from "./ListenRange.ts";
import { ListenRangePositional } from "./ListenRange.ts";
import { timePassesScrobbleThreshold } from "../../utils/TimeUtils.ts";
import type { ScrobbleThresholds } from "../../common/infrastructure/config/source/index.ts";
import { timeToHumanTimestamp } from "../../../core/TimeUtils.ts";
import { todayAwareFormat } from "../../../core/TimeUtils.ts";

export interface PlayerStateIntervals {
    staleInterval?: number
    orphanedInterval?: number
}

export interface PlayerStateOptions extends PlayerStateIntervals {
    allowedDrift?: number
    rtTruth?: boolean
    thresholds?: ScrobbleThresholds
}

export const DefaultPlayerStateOptions: PlayerStateOptions = {};

export const createPlayerOptions = (pollingOpts?: Partial<PollingOptions>, sot: SOURCE_SOT_TYPES = SOURCE_SOT.PLAYER, logger?: Logger): PlayerStateOptions => {
    const {
        interval = 30,
        maxInterval = 60,
        staleAfter,
        orphanedAfter
    } = pollingOpts || {};

    let sa = staleAfter,
    oa = orphanedAfter;

    // if this player is not the source of truth we don't care about waiting around to see if the state comes back
    // in fact, we probably want to get rid of it as fast as possible since its superficial and more of an ephemeral "Now Playing" status than something we are actually tracking
    const staleAfterDefault = sot === SOURCE_SOT.PLAYER ? interval * 3 : interval;
    const orphanedAfterDefault = sot === SOURCE_SOT.PLAYER ? interval * 5 : maxInterval;

    if(sa === undefined) {
        sa = staleAfterDefault;
    }
    if(oa === undefined) {
        oa = orphanedAfterDefault;
    }
    if(oa < sa) {
        oa = sa;
        if(logger !== undefined) {
            logger.warn(`'orhanedAfter' (${oa}s) was less than 'staleAfter' (${sa}s) which is not allowed! 'orhanedAfter' has been set to equal 'staleAfter'`);
        }
    }

    return {
        staleInterval: sa,
        orphanedInterval: oa
    }
}

export abstract class AbstractPlayerState {
    logger: Logger;
    reportedStatus: ReportedPlayerStatus = REPORTED_PLAYER_STATUSES.unknown
    calculatedStatus: CalculatedPlayerStatus = CALCULATED_PLAYER_STATUSES.unknown
    platformId: PlayPlatformId
    sessionId?: string
    stateIntervalOptions: Required<PlayerStateIntervals>;
    currentPlay?: PlayObject
    playFirstSeenAt?: Dayjs
    playLastUpdatedAt?: Dayjs
    isRepeatPlay?: boolean = false;
    currentListenRange?: ListenRange
    listenRanges: ListenRange[] = [];
    createdAt: Dayjs = dayjs();
    stateLastUpdatedAt: Dayjs = dayjs(1);

    lastPlay?: PlayObject
    lastPlayUpdatedAt?: Dayjs
    public hasScrobbled: boolean = false;
    protected thresholds: ScrobbleThresholds = {};

    protected constructor(logger: Logger, platformId: PlayPlatformId, opts: PlayerStateOptions = DefaultPlayerStateOptions) {
        this.platformId = platformId;
        this.logger = childLogger(logger, `Player ${this.platformIdStr}`);

        const {
            staleInterval = 120,
            orphanedInterval = 300,
            thresholds = {}
        } = opts;
        this.stateIntervalOptions = {staleInterval, orphanedInterval: orphanedInterval};
        this.thresholds = thresholds;
    }

    [Symbol.dispose]() {
        if(this.currentListenRange !== undefined) {
            this.currentListenRange[Symbol.dispose]();
        }
        for(const lr of this.listenRanges) {
            lr[Symbol.dispose]();
        }
    }

    protected abstract newListenProgress(data?: Partial<PlayProgress>): ListenProgress;
    protected abstract newListenRange(start?: ListenProgress, end?: ListenProgress, options?: object): ListenRange;

    protected getStaleInterval(): number {
        return this.stateIntervalOptions.staleInterval;
    }

    protected getOrphanedInterval(): number {
        return this.stateIntervalOptions.orphanedInterval;
    }

    get platformIdStr() {
        return genGroupIdStr(this.platformId);
    }

    platformEquals(candidateId: PlayPlatformId) {
        return this.platformId[0] === candidateId[0] && this.platformId[1] === candidateId[1];
    }

    isUpdateStale(reportedTS?: Dayjs) {
        if (this.currentPlay !== undefined) {
            return Math.abs((reportedTS ?? dayjs()).diff(this.playLastUpdatedAt, 'seconds')) > this.getStaleInterval();
        }
        return false;
    }

    checkStale(reportedTS?: Dayjs) {
        const isStale = this.isUpdateStale(reportedTS);
        if (isStale && ![CALCULATED_PLAYER_STATUSES.stale, CALCULATED_PLAYER_STATUSES.orphaned].includes(this.calculatedStatus)) {
            this.calculatedStatus = CALCULATED_PLAYER_STATUSES.stale;
            this.logger.debug(`Stale after no Play updates for ${timeToHumanTimestamp(Math.abs((reportedTS ?? dayjs()).diff(this.playLastUpdatedAt, 'ms')))} (staleAfter ${this.getStaleInterval()}s)`);
            // end current listening sessions
            this.currentListenSessionEnd();
        }
        return isStale;
    }

    isOrphaned() {
        return dayjs().diff(this.stateLastUpdatedAt, 'seconds') >= this.getOrphanedInterval();
    }

    isDead() {
        return dayjs().diff(this.stateLastUpdatedAt, 'seconds') >= this.getOrphanedInterval()* 2;
    }

    checkOrphaned() {
        const isOrphaned = this.isOrphaned();
        if (isOrphaned && this.calculatedStatus !== CALCULATED_PLAYER_STATUSES.orphaned) {
            this.calculatedStatus = CALCULATED_PLAYER_STATUSES.orphaned;
            this.logger.debug(`Orphaned after no Player updates for ${timeToHumanTimestamp(Math.abs(dayjs().diff(this.stateLastUpdatedAt, 'ms')))} ${Math.abs(dayjs().diff(this.stateLastUpdatedAt, 'minutes'))} (orhanedAfter ${this.getOrphanedInterval()}s)`);
        }
        return isOrphaned;
    }

    isProgressing() {
        return AbstractPlayerState.isProgressStatus(this.reportedStatus);
    }

    static isProgressStatus(status: ReportedPlayerStatus) {
        return status !== 'paused' && status !== 'stopped';
    }

    update(state: PlayerStateDataMaybePlay, reportedTS?: Dayjs) {
        this.stateLastUpdatedAt = state.stateUpdatedAt ?? dayjs();
        if(!this.stateLastUpdatedAt.isValid()) {
            this.stateLastUpdatedAt = dayjs();
        }

        const {play, status} = state;

        if (asPlayerStateData(state)) {
            return this.setPlay(state, reportedTS);
        } 

        if (status !== undefined) {
            if (status === 'stopped' && this.reportedStatus !== 'stopped' && this.currentPlay !== undefined) {
                this.stopPlayer();
                const play = this.getPlayedObject(true);
                const emitPlay = !this.hasScrobbled ? play : undefined;
                this.clearPlayer();
                return [play, emitPlay];
            }
            this.reportedStatus = status;
        } else if (this.reportedStatus === undefined) {
            this.reportedStatus = REPORTED_PLAYER_STATUSES.unknown;
        }
        return [];
    }

    protected setPlay(state: PlayerStateData, reportedTS?: Dayjs): [PlayObject, PlayObject?] {
        const {play, status, sessionId, playUpdatedAt} = state;
        this.playLastUpdatedAt = reportedTS ?? playUpdatedAt ?? dayjs();
        if (status !== undefined) {
            this.reportedStatus = status;
        }
        this.sessionId = sessionId;

        if (this.currentPlay !== undefined) {
            if (!this.incomingPlayMatchesExisting(play)) { // TODO check new play date and listen range to see if they intersect
                this.logger.debug(`Incoming play state (${buildTrackString(play, {include: ['trackId', 'artist', 'track']})}) does not match existing state, removing existing: ${buildTrackString(this.currentPlay, {include: ['trackId', 'artist', 'track']})}`);
                this.currentListenSessionEnd();
                const played = this.getPlayedObject(true);
                const emitPlay = !this.hasScrobbled ? played : undefined;
                this.isRepeatPlay = false;
                this.lastPlay = played;
                this.lastPlayUpdatedAt = playUpdatedAt ?? dayjs();
                this.setCurrentPlay(state, {reportedTS});
                if (this.calculatedStatus !== CALCULATED_PLAYER_STATUSES.playing) {
                    this.calculatedStatus = CALCULATED_PLAYER_STATUSES.unknown;
                }
                return [this.requirePlayedObject(), emitPlay];
            } else if (status !== undefined && !AbstractPlayerState.isProgressStatus(status)) {
                this.currentListenSessionEnd();
                this.calculatedStatus = this.reportedStatus;
            } else if (this.isPositionRewind(state.position)) {
                this.logger.debug('New Play is a repeat (rewind detected)');
                this.currentListenSessionEnd();
                this.hasScrobbled = false;
                this.playFirstSeenAt = reportedTS ?? dayjs();
                this.listenRanges = [];
                this.currentListenRange = undefined;
                this.isRepeatPlay = true;
                this.currentListenSessionContinue(state.position, reportedTS);
                return [this.requirePlayedObject(), undefined];
            } else {
                if(this.currentListenRange !== undefined) {
                    const [isSeeked, seekedPos] = this.currentListenRange.seeked(state.position, reportedTS);
                    if (isSeeked !== false) {
                        this.logger.verbose(`Detected player was seeked ${(seekedPos / 1000).toFixed(2)}s, starting new listen range`);
                        if(state.position !== undefined && (this.currentListenRange as ListenRangePositional).end.position === state.position) {
                            this.calculatedStatus = CALCULATED_PLAYER_STATUSES.paused;
                        }
                        // if player has been seeked start a new listen range so our numbers don't get all screwy
                        this.currentListenSessionEnd();
                    }
                }

                this.currentListenSessionContinue(state.position, reportedTS);

                if (!this.hasScrobbled && timePassesScrobbleThreshold(this.thresholds, this.getListenDuration(), this.currentPlay.data.duration).passes) {
                    this.hasScrobbled = true;
                    const scrobblePlay = this.getPlayedObject(false);
                    return [this.requirePlayedObject(), scrobblePlay];
                }
            }
        } else {
            this.isRepeatPlay = false;
            // compensate for Players that report as STOPPED between Plays
            // -- should we check for closeToPlayStart() as well?
            if(this.lastPlay !== undefined && this.lastPlayUpdatedAt !== undefined) {
                const lastPlayDiff = Math.abs(this.lastPlayUpdatedAt.diff(dayjs(), 's'));
                const shortDiff = lastPlayDiff < 20;
                const lastPlayMatch = playObjDataMatch(play, this.lastPlay);
                this.isRepeatPlay = shortDiff && lastPlayMatch;
                this.logger.debug(`Last Play ${shortDiff ? 'was' : 'was not'} within 20s of new Player session and ${lastPlayMatch ? 'does' : 'does not'} match new Play -- ${this.isRepeatPlay ? 'is' : 'is not'} a repeat Play`);
            }
            
            this.setCurrentPlay(state, {reportedTS});
            this.calculatedStatus = CALCULATED_PLAYER_STATUSES.unknown;
        }

        if (this.reportedStatus === undefined) {
            this.reportedStatus = REPORTED_PLAYER_STATUSES.unknown;
        }

        return [this.requirePlayedObject(), undefined];
    }

    protected incomingPlayMatchesExisting(play: PlayObject): boolean { return this.currentPlay !== undefined && playObjDataMatch(this.currentPlay, play); }

    protected clearPlayer() {
        this.lastPlay = this.currentPlay;
        this.lastPlayUpdatedAt = dayjs();
        this.currentPlay = undefined;
        this.playLastUpdatedAt = undefined;
        this.playFirstSeenAt = undefined;
        this.listenRanges = [];
        this.currentListenRange = undefined;
        this.isRepeatPlay = false;
        this.hasScrobbled = false;
    }

    protected stopPlayer() {
        this.reportedStatus = 'stopped';
        this.calculatedStatus = 'stopped';
        this.playLastUpdatedAt = dayjs();
        this.currentListenSessionEnd();
    }

    /** Use when currentPlay is known to be set */
    protected requirePlayedObject(completed: boolean = false): PlayObject {
        const played = this.getPlayedObject(completed);
        if(played === undefined) {
            throw new Error('Expected player to have a current Play but it does not');
        }
        return played;
    }

    public getPlayedObject(completed: boolean = false): PlayObject | undefined {
        if(this.currentPlay !== undefined) {
            const ranges = [...this.listenRanges];
            if (this.currentListenRange !== undefined) {
                ranges.push(this.currentListenRange);
            }
            if(completed) {
                this.logger.debug('Generating play object with playDateCompleted');
            }
            const {
                data,
                meta,
                ...rest
            } = this.currentPlay;
            return {
                data: {
                    ...data,
                    playDate: this.playFirstSeenAt,
                    listenedFor: this.getListenDuration(),
                    listenRanges: ranges.map(x => ({start: x.start, end: x.end})),
                    playDateCompleted: completed ? dayjs() : undefined,
                    repeat: this.isRepeatPlay
                },
                meta: {
                    ...meta,
                    trackProgressPosition: this.getPosition() ?? meta.trackProgressPosition
                },
                ...rest
            }
        }
        return undefined;
    }

    public getListenDuration(): Second{
        let listenDur: number = 0;
        const ranges = [...this.listenRanges];
        if (this.currentListenRange !== undefined) {
            ranges.push(this.currentListenRange);
        }
        for (const range of ranges) {
            listenDur += range.getDuration();
        }
        return listenDur;
    }

    protected abstract currentListenSessionContinue(position?: number | undefined, timestamp?: Dayjs): void;

    protected abstract currentListenSessionEnd(): void;

    /** Check if incoming position for the same track dropped backwards by at least 50% or 4 minutes after track already scrobbled */
    public isPositionRewind(newPosition?: number): boolean {
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

    protected setCurrentPlay(state: PlayerStateData, options?: CurrentPlayOptions) {

        const {
            status,
            reportedTS,
            listenSessionManaged = true
        } = options || {};

        const {play, position} = state;

        this.currentPlay = play;
        this.playFirstSeenAt = reportedTS ?? play.data.playDate ?? dayjs();
        this.listenRanges = [];
        this.currentListenRange = undefined;
        this.hasScrobbled = false;

        this.logger.verbose(`New Play: ${buildTrackString(play, {include: ['trackId', 'artist', 'track', 'session']})}`);

        if (status !== undefined) {
            this.reportedStatus = status;
        }

        if (listenSessionManaged && !['stopped'].includes(this.reportedStatus)) {
            this.currentListenSessionContinue(position, reportedTS);
        }
    }

    public textSummary() {
        const parts = [''];
        let play: string;
        const currentPlay = this.currentPlay;
        const duration = currentPlay?.data.duration;
        if (currentPlay !== undefined) {
            parts.push(`${buildTrackString(currentPlay, {include: ['trackId', 'artist', 'track', 'session']})} @ ${this.playFirstSeenAt !== undefined ? todayAwareFormat(this.playFirstSeenAt) : 'N/A'}`);
        }
        parts.push(`Reported: ${this.reportedStatus.toUpperCase()} | Calculated: ${this.calculatedStatus.toUpperCase()} | Stale: ${this.isUpdateStale() ? 'Yes' : 'No'} | Orphaned: ${this.isOrphaned() ? 'Yes' : 'No'} | Player Updated At: ${todayAwareFormat(this.stateLastUpdatedAt)} | Play Updated At: ${this.playLastUpdatedAt === undefined ? 'N/A' : todayAwareFormat(this.playLastUpdatedAt)}`);
        let progress = '';
        if (this.currentListenRange !== undefined && this.currentListenRange instanceof ListenRangePositional && duration !== undefined && duration !== 0) {
            progress = `${progressBar(this.currentListenRange.end.position / duration, 1, 15)} ${formatNumber(this.currentListenRange.end.position, {toFixed: 0})}/${formatNumber(duration, {toFixed: 0})}s Reported | `;
        }
        let listenedPercent = '';
        if (duration !== undefined && duration !== 0) {
            listenedPercent = formatNumber((this.getListenDuration() / duration) * 100, {
                suffix: '%',
                toFixed: 0
            })
        }
        parts.push(`${progress}Listened For: ${formatNumber(this.getListenDuration(), {toFixed: 0})}s ${listenedPercent}`);
        if (this.currentListenRange !== undefined && this.currentListenRange instanceof ListenRangePositional && this.currentListenRange.rtTruth && duration !== undefined) {
            const rtProgress = `${progressBar((this.currentListenRange.rtPlayer.getPosition() / 1000) / duration, 1, 15)} ${formatNumber(this.currentListenRange.rtPlayer.getPosition() / 1000, {toFixed: 0})}/${formatNumber(duration, {toFixed: 0})}s`;
            parts.push(`${rtProgress} Realtime | Drifted ${formatNumber(Math.abs(this.currentListenRange.getDrift() / 1000), {toFixed: 1})}s (Max ${formatNumber(this.currentListenRange.getAllowedDrift() / 1000, {toFixed: 1})})`);
        }
        return parts.join('\n');
    }

    public logSummary() {
        this.logger.debug(this.textSummary());
    }

    public getPosition(): Second | undefined {
        if(this.calculatedStatus === 'stopped') {
            return undefined;
        }
        if(this.currentListenRange !== undefined) {
            return this.currentListenRange.getPosition();
        }
        if(this.listenRanges.length > 0) {
            return this.listenRanges[this.listenRanges.length - 1].getPosition();
        }
        return undefined;
    }

    public getApiState(): SourcePlayerObj {
        return {
            platformId: this.platformIdStr,
            play: this.getPlayedObject(),
            playLastUpdatedAt: this.playLastUpdatedAt !== undefined ? this.playLastUpdatedAt.toISOString() : undefined,
            playFirstSeenAt: this.playFirstSeenAt !== undefined ? this.playFirstSeenAt.toISOString() : undefined,
            playerLastUpdatedAt: this.stateLastUpdatedAt.toISOString(),
            createdAt: dayjs().unix(),
            position: this.getPosition(),
            listenedDuration: this.getListenDuration(),
            status: {
                reported: this.reportedStatus,
                calculated: this.calculatedStatus,
                stale: this.isUpdateStale(),
                orphaned: this.isOrphaned()
            }
        }
    }

    public transferToNewPlayer(newPlayer: AbstractPlayerState) {
        this.logger.debug(`Transferring state to new Player (${newPlayer.platformIdStr})`);
        newPlayer.calculatedStatus = this.calculatedStatus;
        if(this.currentPlay !== undefined) {
            newPlayer.setCurrentPlay({play: this.currentPlay, platformId: this.platformId}, {status: this.reportedStatus, listenSessionManaged: false});
        }
        newPlayer.currentListenRange = this.currentListenRange;
        newPlayer.listenRanges = this.listenRanges;
        newPlayer.playFirstSeenAt = this.playFirstSeenAt;
        newPlayer.playLastUpdatedAt = this.playLastUpdatedAt;
        newPlayer.hasScrobbled = this.hasScrobbled;
    }
}

export interface CurrentPlayOptions {
    status?: ReportedPlayerStatus,
    reportedTS?: Dayjs
    listenSessionManaged?: boolean
}
