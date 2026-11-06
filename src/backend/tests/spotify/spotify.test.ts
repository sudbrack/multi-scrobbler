import { describe, it, afterEach, beforeEach } from 'mocha';
import { loggerTest } from "@foxxmd/logging";
import { expect } from 'chai';
import EventEmitter from "events";
import sinon from 'sinon';
import clone from 'clone';
import dayjs from 'dayjs';
import MockDate from 'mockdate';
import pEvent from 'p-event';
import { SimpleIntervalJob } from 'toad-scheduler';
import SpotifySource from "../../sources/SpotifySource.ts";
import { envSchemas, type SpotifySourceConfig } from "../../common/infrastructure/config/source/spotify.ts";
import currentlyPlayingNoIsrcPayload from '../plays/spotifyCurrentlyPlayingNoIsrc.json' with { type: "json" };
import playbackState from '../plays/spotifyCurrentPlaybackState.json' with { type: "json" };
import { creditIsrc } from '../../../core/MusicMetadata.ts';
import { RT_TICK_DEFAULT, setRtTick } from '../../sources/PlayerState/RealtimePlayer.ts';
import { SCROBBLE_TS_SOC_START } from '../../../core/Atomic.ts';
import { WildcardEmitter } from '../../common/WildcardEmitter.ts';
import type { MSBackendEventMap } from '../../common/infrastructure/MSBackendEventMap.ts';
import { sleep } from '../../utils.ts';

const createSpotifySource = (options: SpotifySourceConfig['options'] = {}): SpotifySource => {
    const config = {
        id: `test-${Date.now()}-${Math.random()}`,
        data: {
            clientId: 'test-client',
            clientSecret: 'test-secret',
        },
        options
    } as unknown as SpotifySourceConfig;

    return new SpotifySource('test', config, { localUrl: new URL('http://test'), configDir: 'test', logger: loggerTest, version: 'test' }, new EventEmitter());
}

describe('Spotify - ISRC Enrichment', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('Backfills ISRC from the tracks endpoint when currently-playing omits it', async function () {
        const payload = clone(currentlyPlayingNoIsrcPayload);
        payload.item.id = 'track-backfill';

        const source = createSpotifySource();
        const getTrackStub = sinon.stub().resolves({ body: { external_ids: { isrc: 'USRC17607839' } } });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: payload }),
            getTrack: getTrackStub,
        };

        const play = await source.getNowPlaying();

        expect(creditIsrc(play?.data.track)).to.equal('USRC17607839');
        expect(getTrackStub.calledOnceWith('track-backfill')).to.be.true;
    });

    it('Does not re-fetch ISRC for the same track while it is still playing', async function () {
        const payload = clone(currentlyPlayingNoIsrcPayload);
        payload.item.id = 'track-cached';

        const source = createSpotifySource();
        const getTrackStub = sinon.stub().resolves({ body: { external_ids: { isrc: 'USRC17607840' } } });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: payload }),
            getTrack: getTrackStub,
        };

        const first = await source.getNowPlaying();
        const second = await source.getNowPlaying();

        expect(creditIsrc(first?.data.track)).to.equal('USRC17607840');
        expect(creditIsrc(second?.data.track)).to.equal('USRC17607840');
        expect(getTrackStub.callCount).to.equal(1);
    });

    it('Does not call the tracks endpoint when enrichIsrc is disabled', async function () {
        const payload = clone(currentlyPlayingNoIsrcPayload);
        payload.item.id = 'track-disabled';

        const source = createSpotifySource({ enrichIsrc: false });
        const getTrackStub = sinon.stub();
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: payload }),
            getTrack: getTrackStub,
        };

        const play = await source.getNowPlaying();

        expect(creditIsrc(play?.data.track)).to.be.undefined;
        expect(getTrackStub.called).to.be.false;
    });

    it('Does not call tracks endpoint when ISRC is already present', async function () {
        const payload = clone(playbackState);
        payload.item.id = 'playbackTest';

        const source = createSpotifySource();
        const getTrackStub = sinon.stub().resolves({ body: { external_ids: { isrc: 'USRC17607839' } } });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: payload }),
            getTrack: getTrackStub,
        };

        const play = await source.getNowPlaying();

        expect(creditIsrc(play?.data.track)).to.equal('FR9W12915571');
        expect(getTrackStub.called).to.be.false;
    });

    it('Leaves the play scrobbleable when the backfill call fails', async function () {
        const payload = clone(currentlyPlayingNoIsrcPayload);
        payload.item.id = 'track-errors';

        const source = createSpotifySource();
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: payload }),
            getTrack: sinon.stub().rejects(new Error('Spotify tracks endpoint unavailable')),
        };

        const play = await source.getNowPlaying();

        expect(play).to.not.be.undefined;
        expect(creditIsrc(play?.data.track)).to.be.undefined;
        expect(play?.data.track?.name).to.equal('The Sandpits Of Zonhoven');
    });
});

describe('Spotify - Backlog Reconcile Task', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('adds reconcile task to scheduler by default with 15 minute interval', function () {
        const source = createSpotifySource();
        source.initTasks();

        expect(source.scheduler.existsById('reconcile')).to.be.true;
        const job = source.scheduler.getById('reconcile') as SimpleIntervalJob;
        expect((job as any).schedule).to.deep.equal({ minutes: 15, runImmediately: false });
    });

    it('adds reconcile task when scrobbleBacklog is explicitly true', function () {
        const source = createSpotifySource({ scrobbleBacklog: true });
        source.initTasks();

        expect(source.scheduler.existsById('reconcile')).to.be.true;
    });

    it('does not add reconcile task when scrobbleBacklog is false', function () {
        const source = createSpotifySource({ scrobbleBacklog: false });
        source.initTasks();

        expect(source.scheduler.existsById('reconcile')).to.be.false;
    });

    it('does not add duplicate task if initTasks is called again', function () {
        const source = createSpotifySource();
        source.initTasks();
        source.initTasks();

        expect(source.scheduler.getAllJobs().filter(j => j.id === 'reconcile')).to.have.lengthOf(1);
    });

    it('reconcile task executes processBacklog with Reconcile label when source is ready', async function () {
        const source = createSpotifySource();
        const processStub = sinon.stub(source as any, 'processBacklog').resolves();
        sinon.stub(source, 'isReady').returns(true);

        source.initTasks();
        const job = source.scheduler.getById('reconcile') as SimpleIntervalJob;
        await (job as any).task.executeAsync();

        expect(processStub.calledOnce).to.be.true;
        expect(processStub.firstCall.args[1]).to.equal('Reconcile');
    });

    it('reconcile task does not execute processBacklog when source is not ready', async function () {
        const source = createSpotifySource();
        const processStub = sinon.stub(source as any, 'processBacklog').resolves();
        sinon.stub(source, 'isReady').returns(false);

        source.initTasks();
        const job = source.scheduler.getById('reconcile') as SimpleIntervalJob;
        await (job as any).task.executeAsync();

        expect(processStub.called).to.be.false;
    });

    it('reconcile task pushes to errors when processBacklog fails', async function () {
        const source = createSpotifySource();
        const error = new Error('Spotify API error');
        sinon.stub(source as any, 'processBacklog').rejects(error);
        sinon.stub(source, 'isReady').returns(true);

        source.initTasks();
        const job = source.scheduler.getById('reconcile') as SimpleIntervalJob;
        await (job as any).task.executeAsync();

        expect(source.errors).to.include(error);
    });
});

describe('Spotify - Configuration', function () {

    it('Parses SPOTIFY_SCROBBLE_BACKLOG from ENV', function () {
        const parsed = envSchemas.toConfig({
            SPOTIFY_CLIENT_ID: 'cid',
            SPOTIFY_CLIENT_SECRET: 'csec',
            SPOTIFY_REDIRECT_URI: 'http://localhost/callback',
            SPOTIFY_SCROBBLE_BACKLOG: false,
        });

        expect(parsed.options?.scrobbleBacklog).to.be.false;
    });
});

class TestableSpotifySource extends SpotifySource {
    protected async doBuildInitData(): Promise<true | string | undefined> {
        return true;
    }
    protected async doCheckConnection(): Promise<true | string | undefined> {
        return true;
    }
    doAuthentication = async () => {
        return true;
    }
}

const createInitializedSpotifySource = async (options: SpotifySourceConfig['options'] = {}) => {
    const emitter = new WildcardEmitter<MSBackendEventMap>();
    const config = {
        id: `test-spotify-${Date.now()}-${Math.random()}`,
        data: {
            clientId: 'test-client',
            clientSecret: 'test-secret',
        },
        options
    } as unknown as SpotifySourceConfig;
    const source = new TestableSpotifySource('spotify-test', config, { localUrl: new URL('http://test'), configDir: 'test', logger: loggerTest, version: 'test' }, emitter);
    source.queueIdleMs = 2;
    source.queueConcurrency = 1;
    source.stopPollingWaitInterval = 10;
    await source.initialize();
    source.scheduler.stop();
    await source.startDiscoveryQueue();
    return source;
};

const makeCurrentlyPlayingPayload = (opts: {
    id: string;
    name: string;
    artistName?: string;
    durationMs: number;
    progressMs: number;
    timestampMs: number;
    isPlaying?: boolean;
}): SpotifyApi.CurrentlyPlayingObject => {
    const payload = clone(playbackState) as unknown as SpotifyApi.CurrentlyPlayingObject;
    payload.timestamp = opts.timestampMs;
    payload.progress_ms = opts.progressMs;
    payload.is_playing = opts.isPlaying ?? true;
    const item = payload.item as SpotifyApi.TrackObjectFull;
    item.id = opts.id;
    item.name = opts.name;
    item.duration_ms = opts.durationMs;
    if (item.external_ids !== undefined) {
        item.external_ids.isrc = `ISRC-${opts.id}`;
    }
    if (opts.artistName !== undefined) {
        item.artists = [{ ...item.artists[0], id: `artist-${opts.id}`, name: opts.artistName }];
        item.album.artists = item.artists;
    }
    return payload;
};

const makeHistoryPayload = (opts: {
    id: string;
    name: string;
    artistName?: string;
    durationMs: number;
    playedAtIso: string;
}): SpotifyApi.PlayHistoryObject => {
    const base = clone(playbackState.item) as unknown as SpotifyApi.TrackObjectFull;
    base.id = opts.id;
    base.name = opts.name;
    base.duration_ms = opts.durationMs;
    if (base.external_ids !== undefined) {
        base.external_ids.isrc = `ISRC-${opts.id}`;
    }
    if (opts.artistName !== undefined) {
        base.artists = [{ ...base.artists[0], id: `artist-${opts.id}`, name: opts.artistName }];
        base.album.artists = base.artists;
    }
    return {
        track: base,
        played_at: opts.playedAtIso,
        context: null as any
    };
};

describe('Spotify - 50% Scrobbling, Replays & History Reconciliation', function () {

    beforeEach(function () {
        setRtTick(1);
    });

    afterEach(function () {
        MockDate.reset();
        setRtTick(RT_TICK_DEFAULT);
        sinon.restore();
    });

    it('1. Derives exact start timestamp (timestamp - progress_ms) and emits scrobble on track finish with full listenedFor', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(10, 'minutes').startOf('second');

        // Track started at baseTime, snapshot taken 10s into track (progress_ms = 10_000)
        MockDate.set(baseTime.add(10, 'seconds').toDate());
        await sleep(15);
        const poll1 = makeCurrentlyPlayingPayload({
            id: 'track-50pct',
            name: 'Fifty Percent Song',
            durationMs: 200_000,
            progressMs: 10_000,
            timestampMs: baseTime.add(10, 'seconds').valueOf()
        });
        const formatted = SpotifySource.formatPlayObj(poll1);
        expect(formatted.data.playDate?.unix()).to.equal(baseTime.unix());
        expect(formatted.meta.scrobbleTsSOC).to.equal(SCROBBLE_TS_SOC_START);

        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: poll1 }),
            getTrack: sinon.stub()
        };
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Advance to 60s (50s listened < 100s threshold) -> no scrobble yet
        MockDate.set(baseTime.add(60, 'seconds').toDate());
        await sleep(15);
        const poll2 = makeCurrentlyPlayingPayload({
            id: 'track-50pct',
            name: 'Fifty Percent Song',
            durationMs: 200_000,
            progressMs: 60_000,
            timestampMs: baseTime.add(60, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: poll2 });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Advance to 115s (105s listened >= 100s 50% threshold) -> qualifies (hasScrobbled=true) but waits for session end to preserve accurate listening time
        MockDate.set(baseTime.add(115, 'seconds').toDate());
        await sleep(15);
        const poll3 = makeCurrentlyPlayingPayload({
            id: 'track-50pct',
            name: 'Fifty Percent Song',
            durationMs: 200_000,
            progressMs: 115_000,
            timestampMs: baseTime.add(115, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: poll3 });
        expect(await source.getRecentlyPlayed()).to.be.empty;
        const player = Array.from(source.players.values())[0];
        expect(player?.hasScrobbled).to.be.true;

        // Continue playing to 190s -> actively playing, no premature emission
        MockDate.set(baseTime.add(190, 'seconds').toDate());
        await sleep(15);
        const poll4 = makeCurrentlyPlayingPayload({
            id: 'track-50pct',
            name: 'Fifty Percent Song',
            durationMs: 200_000,
            progressMs: 190_000,
            timestampMs: baseTime.add(190, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: poll4 });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Track completes and switches to next track at 200s -> emits completed play with full listenedFor!
        MockDate.set(baseTime.add(205, 'seconds').toDate());
        await sleep(15);
        const pollNext = makeCurrentlyPlayingPayload({
            id: 'track-next',
            name: 'Next Song',
            artistName: 'Another Artist',
            durationMs: 180_000,
            progressMs: 5_000,
            timestampMs: baseTime.add(205, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pollNext });
        const emitted = await source.getRecentlyPlayed();
        expect(emitted).to.have.lengthOf(1);
        expect(emitted[0].data.track?.name).to.equal('Fifty Percent Song');
        expect(emitted[0].data.playDate?.unix()).to.equal(baseTime.unix());
        expect(emitted[0].meta.scrobbleTsSOC).to.equal(SCROBBLE_TS_SOC_START);
        expect(emitted[0].data.playDateCompleted).to.not.be.undefined;
        expect(emitted[0].data.listenedFor).to.be.closeTo(190, 10);
    });

    it('2 & 4. Handles post-50% rewind to start as a second scrobble without false duplicate flagging', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(15, 'minutes').startOf('second');

        // Start Play #1 at 0s (duration = 180s, threshold = 90s)
        MockDate.set(baseTime.toDate());
        await sleep(15);
        const p1Start = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: baseTime.valueOf()
        });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: p1Start }),
            getTrack: sinon.stub()
        };
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Play #1 hits 100s (> 50%) -> qualifies (hasScrobbled=true) but waits for session end to preserve accurate listening time
        MockDate.set(baseTime.add(100, 'seconds').toDate());
        await sleep(15);
        const p1Mid = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 100_000,
            timestampMs: baseTime.add(100, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: p1Mid });
        expect(await source.getRecentlyPlayed()).to.be.empty;
        const player = Array.from(source.players.values())[0];
        expect(player?.hasScrobbled).to.be.true;

        // Play #1 continues to 160s, then user rewinds to 5s (dropped 155s >= 90s, 5s <= 30s start guard)
        MockDate.set(baseTime.add(160, 'seconds').toDate());
        await sleep(15);
        const p1NearEnd = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 160_000,
            timestampMs: baseTime.add(160, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: p1NearEnd });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        const rewindTime = baseTime.add(165, 'seconds');
        MockDate.set(rewindTime.toDate());
        await sleep(15);
        const p2Rewind = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 5_000,
            timestampMs: rewindTime.valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: p2Rewind });
        // Rewind finishes session for Play #1 -> emits Play #1 with full 160s listened duration!
        const firstEmit = await source.getRecentlyPlayed();
        expect(firstEmit).to.have.lengthOf(1);
        expect(firstEmit[0].data.listenedFor).to.be.closeTo(160, 5);
        expect(firstEmit[0].data.playDateCompleted).to.not.be.undefined;
        await source.queuePlay(firstEmit);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        // Play #2 progresses from 5s to 100s (95s listened >= 90s threshold) -> actively playing, waits for session end
        const p2MidTime = rewindTime.add(95, 'seconds');
        MockDate.set(p2MidTime.toDate());
        await sleep(15);
        const p2Mid = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 100_000,
            timestampMs: p2MidTime.valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: p2Mid });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Play #2 finishes at 180s and then switches to next song -> emits Play #2 with full 175s listened duration!
        const p2EndTime = rewindTime.add(175, 'seconds');
        MockDate.set(p2EndTime.toDate());
        await sleep(15);
        const p2End = makeCurrentlyPlayingPayload({
            id: 'track-replay',
            name: 'Replayable Banger',
            durationMs: 180_000,
            progressMs: 180_000,
            timestampMs: p2EndTime.valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: p2End });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        const nextTime = p2EndTime.add(5, 'seconds');
        MockDate.set(nextTime.toDate());
        await sleep(15);
        const pNext = makeCurrentlyPlayingPayload({
            id: 'track-next',
            name: 'Next Song',
            artistName: 'Another Artist',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: nextTime.valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pNext });
        const secondEmit = await source.getRecentlyPlayed();
        expect(secondEmit).to.have.lengthOf(1);
        expect(secondEmit[0].data.repeat).to.be.true;
        expect(secondEmit[0].data.listenedFor).to.be.closeTo(175, 5);

        await source.queuePlay(secondEmit);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(2);
    });

    it('5. Does not duplicate scrobble when history reconcile runs after early skip (60%) or pause', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(20, 'minutes').startOf('second');

        // Start track at baseTime (duration = 200s, threshold = 100s)
        MockDate.set(baseTime.toDate());
        await sleep(15);
        const pStart = makeCurrentlyPlayingPayload({
            id: 'track-early-skip',
            name: 'Paused Or Skipped Track',
            durationMs: 200_000,
            progressMs: 0,
            timestampMs: baseTime.valueOf()
        });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: pStart }),
            getMyRecentlyPlayedTracks: sinon.stub(),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        // Crosses 50% at 110s -> qualifies (hasScrobbled = true) but waits for session end to preserve accurate listening time
        MockDate.set(baseTime.add(110, 'seconds').toDate());
        await sleep(15);
        const pMid = makeCurrentlyPlayingPayload({
            id: 'track-early-skip',
            name: 'Paused Or Skipped Track',
            durationMs: 200_000,
            progressMs: 110_000,
            timestampMs: baseTime.add(110, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pMid });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // User skips at 60% (120s after baseTime) to next track -> ends session and emits live scrobble with accurate 120s listened!
        MockDate.set(baseTime.add(120, 'seconds').toDate());
        await sleep(15);
        const pSkip = makeCurrentlyPlayingPayload({
            id: 'track-early-skip',
            name: 'Paused Or Skipped Track',
            durationMs: 200_000,
            progressMs: 120_000,
            timestampMs: baseTime.add(120, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pSkip });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        MockDate.set(baseTime.add(121, 'seconds').toDate());
        await sleep(15);
        const pNext = makeCurrentlyPlayingPayload({
            id: 'track-next',
            name: 'Next Song',
            artistName: 'Another Artist',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: baseTime.add(121, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pNext });
        const liveEmitted = await source.getRecentlyPlayed();
        expect(liveEmitted).to.have.lengthOf(1);
        expect(liveEmitted[0].data.listenedFor).to.be.closeTo(120, 5);
        await source.queuePlay(liveEmitted);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        // Spotify history logs played_at = baseTime + 120s.
        // 15 minutes later, reconcile job runs.
        MockDate.set(baseTime.add(15, 'minutes').toDate());
        await sleep(15);
        const historyItem = makeHistoryPayload({
            id: 'track-early-skip',
            name: 'Paused Or Skipped Track',
            durationMs: 200_000,
            playedAtIso: baseTime.add(120, 'seconds').toISOString()
        });
        (source as any).spotifyApi.getMyRecentlyPlayedTracks.resolves({
            body: { items: [historyItem], total: 1, limit: 50, next: null, cursors: null }
        });

        await (source as any).processBacklog(new AbortController().signal, 'Reconcile');
        // Since findPreQueueExistingPlay matches the completion window, nothing new is discovered
        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(1);
    });

    it('5b. Does not duplicate scrobble when user pauses for 2 minutes mid-track and finishes later', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(25, 'minutes').startOf('second');

        // Start track at baseTime (duration = 200s, threshold = 100s)
        MockDate.set(baseTime.toDate());
        await sleep(15);
        const pStart = makeCurrentlyPlayingPayload({
            id: 'track-paused-2min',
            name: 'Paused For Two Minutes',
            durationMs: 200_000,
            progressMs: 0,
            timestampMs: baseTime.valueOf()
        });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: pStart }),
            getMyRecentlyPlayedTracks: sinon.stub(),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        // Crosses 50% at 110s -> qualifies (hasScrobbled = true) but actively playing so no premature emission
        MockDate.set(baseTime.add(110, 'seconds').toDate());
        await sleep(15);
        const pMid = makeCurrentlyPlayingPayload({
            id: 'track-paused-2min',
            name: 'Paused For Two Minutes',
            durationMs: 200_000,
            progressMs: 110_000,
            timestampMs: baseTime.add(110, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pMid });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // User pauses at 110s for 120s (2 minutes), then resumes at T + 230s and finishes at T + 320s
        MockDate.set(baseTime.add(230, 'seconds').toDate());
        await sleep(15);
        const pResumed = makeCurrentlyPlayingPayload({
            id: 'track-paused-2min',
            name: 'Paused For Two Minutes',
            durationMs: 200_000,
            progressMs: 110_000,
            timestampMs: baseTime.add(230, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pResumed });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        MockDate.set(baseTime.add(320, 'seconds').toDate());
        await sleep(15);
        const pFinished = makeCurrentlyPlayingPayload({
            id: 'track-paused-2min',
            name: 'Paused For Two Minutes',
            durationMs: 200_000,
            progressMs: 200_000,
            timestampMs: baseTime.add(320, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pFinished });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        MockDate.set(baseTime.add(321, 'seconds').toDate());
        await sleep(15);
        const pNext = makeCurrentlyPlayingPayload({
            id: 'track-after-pause',
            name: 'Next Track After Pause',
            artistName: 'Another Artist',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: baseTime.add(321, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pNext });
        const liveEmitted = await source.getRecentlyPlayed();
        expect(liveEmitted).to.have.lengthOf(1);
        expect(liveEmitted[0].data.listenedFor).to.be.closeTo(200, 5);
        await source.queuePlay(liveEmitted);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        // 15 minutes later, Spotify History reports completion at baseTime + 320s (120s past playDate + duration!)
        MockDate.set(baseTime.add(20, 'minutes').toDate());
        await sleep(15);
        const historyItem = makeHistoryPayload({
            id: 'track-paused-2min',
            name: 'Paused For Two Minutes',
            durationMs: 200_000,
            playedAtIso: baseTime.add(320, 'seconds').toISOString()
        });
        (source as any).spotifyApi.getMyRecentlyPlayedTracks.resolves({
            body: { items: [historyItem], total: 1, limit: 50, next: null, cursors: null }
        });

        await (source as any).processBacklog(new AbortController().signal, 'Reconcile');
        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(1);
    });

    it('4b. Handles rapid track switches (A -> B -> A) by discarding sub-50% Song B and scrobbling both A sessions', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(20, 'minutes').startOf('second');

        // Song A plays to 100s (duration = 180s, threshold = 90s) -> qualifies (hasScrobbled=true) but actively playing
        MockDate.set(baseTime.toDate());
        await sleep(15);
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({
                body: makeCurrentlyPlayingPayload({
                    id: 'song-a',
                    name: 'Song A',
                    durationMs: 180_000,
                    progressMs: 0,
                    timestampMs: baseTime.valueOf()
                })
            }),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        MockDate.set(baseTime.add(100, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a',
                name: 'Song A',
                durationMs: 180_000,
                progressMs: 100_000,
                timestampMs: baseTime.add(100, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // User skips to Song B for 8 seconds -> Song A #1 ends and is emitted with full listened duration!
        MockDate.set(baseTime.add(110, 'seconds').toDate());
        await sleep(10);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-b',
                name: 'Song B',
                artistName: 'Artist B',
                durationMs: 200_000,
                progressMs: 0,
                timestampMs: baseTime.add(110, 'seconds').valueOf()
            })
        });
        const emitA1 = await source.getRecentlyPlayed();
        expect(emitA1).to.have.lengthOf(1);
        expect(emitA1[0].data.track?.name).to.equal('Song A');
        await source.queuePlay(emitA1);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        MockDate.set(baseTime.add(118, 'seconds').toDate());
        await sleep(10);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-b',
                name: 'Song B',
                artistName: 'Artist B',
                durationMs: 200_000,
                progressMs: 8_000,
                timestampMs: baseTime.add(118, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Switch back to Song A at T + 120s
        const a2Start = baseTime.add(120, 'seconds');
        MockDate.set(a2Start.toDate());
        await sleep(10);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a',
                name: 'Song A',
                durationMs: 180_000,
                progressMs: 0,
                timestampMs: a2Start.valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Song B should be recorded as discarded
        const discarded = await source.playRepo.findPlays({ state: ['discarded'] });
        expect(discarded).to.have.lengthOf(1);
        expect(discarded[0].play.data.track?.name).to.equal('Song B');

        // Song A plays to 100s in its new session -> qualifies (hasScrobbled=true)
        MockDate.set(a2Start.add(100, 'seconds').toDate());
        await sleep(10);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a',
                name: 'Song A',
                durationMs: 180_000,
                progressMs: 100_000,
                timestampMs: a2Start.add(100, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Song A #2 finishes and switches to next song at 180s -> emits Play #2 of Song A!
        const a2End = a2Start.add(180, 'seconds');
        MockDate.set(a2End.toDate());
        await sleep(10);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-next',
                name: 'Song Next',
                durationMs: 180_000,
                progressMs: 0,
                timestampMs: a2End.valueOf()
            })
        });
        const emitA2 = await source.getRecentlyPlayed();
        expect(emitA2).to.have.lengthOf(1);
        expect(emitA2[0].data.track?.name).to.equal('Song A');
        await source.queuePlay(emitA2);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(2);
    });

    it('6. Persists sub-50% skip (35s) as state="discarded" and does NOT resurrect it during history reconcile', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(20, 'minutes').startOf('second');

        // Track A starts at 0s (duration = 200s, threshold = 100s)
        MockDate.set(baseTime.toDate());
        await sleep(15);
        const trackAStart = makeCurrentlyPlayingPayload({
            id: 'track-skipped-35s',
            name: 'Thirty Five Second Skip',
            durationMs: 200_000,
            progressMs: 0,
            timestampMs: baseTime.valueOf()
        });
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({ body: trackAStart }),
            getMyRecentlyPlayedTracks: sinon.stub(),
            getTrack: sinon.stub()
        };
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Track A plays to 35s
        MockDate.set(baseTime.add(35, 'seconds').toDate());
        await sleep(15);
        const trackA35s = makeCurrentlyPlayingPayload({
            id: 'track-skipped-35s',
            name: 'Thirty Five Second Skip',
            durationMs: 200_000,
            progressMs: 35_000,
            timestampMs: baseTime.add(35, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: trackA35s });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // User skips to Track B at 36s -> Track A is evaluated (< 50%) and persisted as state: 'discarded'
        MockDate.set(baseTime.add(36, 'seconds').toDate());
        await sleep(15);
        const trackBStart = makeCurrentlyPlayingPayload({
            id: 'track-b-next',
            name: 'Next Song',
            artistName: 'Other Artist',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: baseTime.add(36, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: trackBStart });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        const discardedInDb = await source.playRepo.findPlays({ state: ['discarded'] });
        expect(discardedInDb).to.have.lengthOf(1);
        expect(discardedInDb[0].play.data.track?.name).to.equal('Thirty Five Second Skip');

        // 15 minutes later, Spotify History returns the 35s track (since Spotify logs >=30s listens)
        MockDate.set(baseTime.add(15, 'minutes').toDate());
        await sleep(15);
        const historyItem = makeHistoryPayload({
            id: 'track-skipped-35s',
            name: 'Thirty Five Second Skip',
            durationMs: 200_000,
            playedAtIso: baseTime.add(36, 'seconds').toISOString()
        });
        (source as any).spotifyApi.getMyRecentlyPlayedTracks.resolves({
            body: { items: [historyItem], total: 1, limit: 50, next: null, cursors: null }
        });

        await (source as any).processBacklog(new AbortController().signal, 'Reconcile');
        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.be.empty;
    });

    it('7. Recovers 3 missed plays from Spotify History after a live API blackout while ignoring in-flight (< 2 min) plays', async function () {
        await using source = await createInitializedSpotifySource();
        const now = dayjs().startOf('second');
        MockDate.set(now.toDate());
        await sleep(15);

        // 3 tracks played 10, 7, and 4 minutes ago during a Spotify live API blackout; plus 1 in-flight track 30s ago
        const historyItems = [
            makeHistoryPayload({
                id: 'missed-1',
                name: 'Missed Track One',
                artistName: 'Band Alpha',
                durationMs: 180_000,
                playedAtIso: now.subtract(10, 'minutes').toISOString()
            }),
            makeHistoryPayload({
                id: 'missed-2',
                name: 'Missed Track Two',
                artistName: 'Band Beta',
                durationMs: 180_000,
                playedAtIso: now.subtract(7, 'minutes').toISOString()
            }),
            makeHistoryPayload({
                id: 'missed-3',
                name: 'Missed Track Three',
                artistName: 'Band Gamma',
                durationMs: 180_000,
                playedAtIso: now.subtract(4, 'minutes').toISOString()
            }),
            makeHistoryPayload({
                id: 'inflight-4',
                name: 'In Flight Track Four',
                artistName: 'Band Delta',
                durationMs: 180_000,
                playedAtIso: now.subtract(30, 'seconds').toISOString()
            })
        ];

        (source as any).spotifyApi = {
            getMyRecentlyPlayedTracks: sinon.stub().resolves({
                body: { items: historyItems, total: historyItems.length, limit: 50, next: null, cursors: null }
            })
        };

        await (source as any).processBacklog(new AbortController().signal, 'Reconcile');
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(3);
        expect(discovered.map(x => x.data.track?.name)).to.deep.equal([
            'Missed Track One',
            'Missed Track Two',
            'Missed Track Three'
        ]);
    });

    it('4c. Handles rapid sub-10s track switches (A 4s skip -> B 3s skip -> A full listen) without colliding with discarded A', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(20, 'minutes').startOf('second');

        // Start Song A at T_0, listen for 4s (< 50%)
        MockDate.set(baseTime.toDate());
        await sleep(15);
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({
                body: makeCurrentlyPlayingPayload({
                    id: 'song-a-rapid',
                    name: 'Song A Rapid',
                    durationMs: 180_000,
                    progressMs: 0,
                    timestampMs: baseTime.valueOf()
                })
            }),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        MockDate.set(baseTime.add(4, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a-rapid',
                name: 'Song A Rapid',
                durationMs: 180_000,
                progressMs: 4_000,
                timestampMs: baseTime.add(4, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Switch to Song B at T_0 + 4s for 3s -> Song A #1 is persisted as state: 'discarded'
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-b-rapid',
                name: 'Song B Rapid',
                artistName: 'Artist B',
                durationMs: 200_000,
                progressMs: 0,
                timestampMs: baseTime.add(4, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        MockDate.set(baseTime.add(7, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-b-rapid',
                name: 'Song B Rapid',
                artistName: 'Artist B',
                durationMs: 200_000,
                progressMs: 3_000,
                timestampMs: baseTime.add(7, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Switch back to Song A at T_0 + 7s (only 7s after Song A #1's start timestamp!)
        const a2Start = baseTime.add(7, 'seconds');
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a-rapid',
                name: 'Song A Rapid',
                durationMs: 180_000,
                progressMs: 0,
                timestampMs: a2Start.valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Both sub-50% skips (A #1 and B #1) are persisted as discarded
        const discarded = await source.playRepo.findPlays({ state: ['discarded'] });
        expect(discarded).to.have.lengthOf(2);

        // Song A #2 plays past 50% (100s) -> qualifies (hasScrobbled=true)
        MockDate.set(a2Start.add(100, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-a-rapid',
                name: 'Song A Rapid',
                durationMs: 180_000,
                progressMs: 100_000,
                timestampMs: a2Start.add(100, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Song A #2 finishes and switches to next track at 180s -> must NOT collide with discarded Song A #1!
        const a2End = a2Start.add(180, 'seconds');
        MockDate.set(a2End.toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'song-next',
                name: 'Song Next',
                durationMs: 180_000,
                progressMs: 0,
                timestampMs: a2End.valueOf()
            })
        });
        const emitA2 = await source.getRecentlyPlayed();
        expect(emitA2).to.have.lengthOf(1);
        await source.queuePlay(emitA2);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(1);
        expect(discovered[0].data.track?.name).to.equal('Song A Rapid');
    });

    it('5c. Preserves hasScrobbled across stale pause (> 3m) so unpausing + rewinding to 0:05 scrobbles Play #2 and finishing updates playDateCompleted', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(30, 'minutes').startOf('second');

        // Start 200s track at baseTime, scrobble at 110s
        MockDate.set(baseTime.toDate());
        await sleep(15);
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({
                body: makeCurrentlyPlayingPayload({
                    id: 'stale-pause-track',
                    name: 'Stale Pause Track',
                    durationMs: 200_000,
                    progressMs: 0,
                    timestampMs: baseTime.valueOf()
                })
            }),
            getMyRecentlyPlayedTracks: sinon.stub(),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        // Listen to 110s (50% threshold is 100s) -> qualifies (hasScrobbled=true) but actively playing
        MockDate.set(baseTime.add(110, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'stale-pause-track',
                name: 'Stale Pause Track',
                durationMs: 200_000,
                progressMs: 110_000,
                timestampMs: baseTime.add(110, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Simulate stale pause (> 3 minutes with no fresh state) -> triggers cleanupPlayer and emits Play #1!
        MockDate.set(baseTime.add(350, 'seconds').toDate());
        await sleep(15);
        const emit1 = await source.processRecentPlays([]);
        expect(emit1).to.have.lengthOf(1);
        expect(emit1[0].data.listenedFor).to.be.closeTo(110, 5);
        await source.queuePlay(emit1);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        // User unpauses at baseTime + 360s and rewinds to 0:05 (5_000ms) -> triggers Play #2!
        const rewindTime = baseTime.add(360, 'seconds');
        MockDate.set(rewindTime.toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'stale-pause-track',
                name: 'Stale Pause Track',
                durationMs: 200_000,
                progressMs: 5_000,
                timestampMs: rewindTime.valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Play #2 reaches 110s -> actively playing, no premature emission
        MockDate.set(rewindTime.add(105, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'stale-pause-track',
                name: 'Stale Pause Track',
                durationMs: 200_000,
                progressMs: 110_000,
                timestampMs: rewindTime.add(105, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Play #2 finishes at 200s and switches to next track -> emits Play #2!
        const p2End = rewindTime.add(200, 'seconds');
        MockDate.set(p2End.toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'track-next',
                name: 'Next Song',
                artistName: 'Another Artist',
                durationMs: 180_000,
                progressMs: 0,
                timestampMs: p2End.valueOf()
            })
        });
        const emit2 = await source.getRecentlyPlayed();
        expect(emit2).to.have.lengthOf(1);
        await source.queuePlay(emit2);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(2);
    });

    it('5d. Handles 40% listen (80s) + rewind to 0:00 + full listen (280s total) and suppresses both intermediate (80s) and final (280s) Spotify History entries', async function () {
        await using source = await createInitializedSpotifySource();
        const baseTime = dayjs().subtract(30, 'minutes').startOf('second');

        // 1. Start 200s song at baseTime
        MockDate.set(baseTime.toDate());
        await sleep(15);
        (source as any).spotifyApi = {
            getMyCurrentPlayingTrack: sinon.stub().resolves({
                body: makeCurrentlyPlayingPayload({
                    id: 'track-40pct-rewind',
                    name: 'Forty Percent Rewind Track',
                    durationMs: 200_000,
                    progressMs: 0,
                    timestampMs: baseTime.valueOf()
                })
            }),
            getMyRecentlyPlayedTracks: sinon.stub(),
            getTrack: sinon.stub()
        };
        await source.getRecentlyPlayed();

        // 2. Listen to 40% (80s) -> does not scrobble yet (< 100s)
        MockDate.set(baseTime.add(80, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'track-40pct-rewind',
                name: 'Forty Percent Rewind Track',
                durationMs: 200_000,
                progressMs: 80_000,
                timestampMs: baseTime.add(80, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // 3. Rewind to beginning (0s) at baseTime + 80s -> closes Range 1 (80s) and opens Range 2 at 0s
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'track-40pct-rewind',
                name: 'Forty Percent Rewind Track',
                durationMs: 200_000,
                progressMs: 0,
                timestampMs: baseTime.add(80, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // 4. Listen 20s into rewound song (baseTime + 100s, progress = 20_000ms) -> cumulative 80s + 20s = 100s (50%) -> qualifies (hasScrobbled=true)
        MockDate.set(baseTime.add(100, 'seconds').toDate());
        await sleep(15);
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({
            body: makeCurrentlyPlayingPayload({
                id: 'track-40pct-rewind',
                name: 'Forty Percent Rewind Track',
                durationMs: 200_000,
                progressMs: 20_000,
                timestampMs: baseTime.add(100, 'seconds').valueOf()
            })
        });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // 5. Continue listening to the end of the rewound song (baseTime + 280s, progress = 200_000ms)
        MockDate.set(baseTime.add(280, 'seconds').toDate());
        await sleep(15);
        const pollFinish = makeCurrentlyPlayingPayload({
            id: 'track-40pct-rewind',
            name: 'Forty Percent Rewind Track',
            durationMs: 200_000,
            progressMs: 200_000,
            timestampMs: baseTime.add(280, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pollFinish });
        expect(await source.getRecentlyPlayed()).to.be.empty;

        // Switch to next track at 281s -> emits with full 280s listened!
        MockDate.set(baseTime.add(281, 'seconds').toDate());
        await sleep(15);
        const pollNext = makeCurrentlyPlayingPayload({
            id: 'track-next',
            name: 'Next Song',
            durationMs: 180_000,
            progressMs: 0,
            timestampMs: baseTime.add(281, 'seconds').valueOf()
        });
        (source as any).spotifyApi.getMyCurrentPlayingTrack.resolves({ body: pollNext });
        const emitAtEnd = await source.getRecentlyPlayed();
        expect(emitAtEnd).to.have.lengthOf(1);
        expect(emitAtEnd[0].data.listenedFor).to.be.closeTo(280, 5);
        await source.queuePlay(emitAtEnd);
        await Promise.race([pEvent(source.emitter, 'queueEmptied'), pEvent(source.emitter, 'discoveryQueueError')]);

        // 6. 15 minutes later, Spotify History Reconcile runs and reports BOTH the 80s rewind entry AND the 280s completion entry
        MockDate.set(baseTime.add(20, 'minutes').toDate());
        await sleep(15);
        const historyItems = [
            makeHistoryPayload({
                id: 'track-40pct-rewind',
                name: 'Forty Percent Rewind Track',
                durationMs: 200_000,
                playedAtIso: baseTime.add(80, 'seconds').toISOString()
            }),
            makeHistoryPayload({
                id: 'track-40pct-rewind',
                name: 'Forty Percent Rewind Track',
                durationMs: 200_000,
                playedAtIso: baseTime.add(280, 'seconds').toISOString()
            })
        ];
        (source as any).spotifyApi.getMyRecentlyPlayedTracks.resolves({
            body: { items: historyItems, total: 2, limit: 50, next: null, cursors: null }
        });

        await (source as any).processBacklog(new AbortController().signal, 'Reconcile');

        // Both history entries are absorbed by the single live session (still only 1 discovered play!)
        const discovered = await source.getRecentlyDiscoveredPlays();
        expect(discovered).to.have.lengthOf(1);
    });
});

