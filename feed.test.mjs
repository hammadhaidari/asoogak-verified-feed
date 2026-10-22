import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, buildFeed, seasonsToProbe, titleVerdict, targetFor, proofAge, slimItem, hashKey, OVERVIEW_MAX, HOT_TARGET_MS, TAIL_TARGET_MS, MIN_RECHECK_MS, DEAD_RETAIN_MS } from './feed-core.mjs';
import { classifyResolver, lightProbe } from './light-check.mjs';
import { resolverUrl } from './probe-shard.mjs';

const H = 3600000, NOW = 1_000_000 * H;
const movie = (id, popularity = 1, availabilityH = 5) => ({ id, media_type: 'movie', title: 'M' + id, popularity, overview: 'long text', availability_at: NOW - availabilityH * H, verified_v: 2 });
const show = (id, seasons = [1, 2, 3], popularity = 1) => ({ id, media_type: 'tv', name: 'S' + id, popularity, playable_seasons: seasons, availability_at: NOW - 5 * H, verified_v: 2 });

test('resolver answers: only a definitive "no stream" is dead; throttling and outages prove nothing', () => {
    const live = { stream: { qualities: { 1080: { url: 'https://cdn/x.mp4' } } } };
    assert.equal(classifyResolver(200, live).state, 'alive');
    assert.equal(classifyResolver(200, { stream: { playlist: 'https://cdn/x.m3u8' } }).state, 'alive');
    assert.deepEqual(classifyResolver(200, {}), { state: 'dead', reason: 'no-stream' });
    assert.deepEqual(classifyResolver(200, { stream: { qualities: { 720: {} } } }), { state: 'dead', reason: 'no-stream' });
    assert.equal(classifyResolver(200, { stream: { playlist: 'http://cdn/x.m3u8' } }).reason, 'insecure');
    for (const status of [400, 403, 404, 410, 422, 428]) assert.equal(classifyResolver(status).state, 'dead');
    assert.equal(classifyResolver(429).state, 'limited');
    for (const status of [0, 500, 502, 503, 401, 418]) assert.equal(classifyResolver(status).state, 'unknown');
});

test('light probe is one request; a throttled answer retries once through a proxy egress, never more', async () => {
    const calls = [];
    const fetchImpl = async url => { calls.push(url); return { status: calls.length === 1 ? 429 : 200, json: async () => ({ stream: { playlist: 'https://cdn/a.m3u8' } }), body: { cancel: async () => {} } }; };
    const options = { secret: 'ab'.repeat(32), resolverUrl: key => 'https://r/' + key, fetchImpl, proxies: ['https://proxy/?url='] };
    assert.equal((await lightProbe('movie:1', options)).state, 'alive');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^https:\/\/proxy\/\?url=https%3A%2F%2Fr%2Fmovie%3A1&base=/);
    calls.length = 0;
    const direct = await lightProbe('movie:2', { ...options, proxies: [], fetchImpl: async url => { calls.push(url); return { status: 200, json: async () => ({}), body: { cancel: async () => {} } }; } });
    assert.equal(direct.state, 'dead'); assert.equal(calls.length, 1);
});

test('token URL matches the scanner exactly (same secret, same id => same request shape)', () => {
    const url = resolverUrl('tv:1396:s2:e1', 'cd'.repeat(32), 1_700_000_000_000);
    assert.match(url, /^https:\/\/vidlink\.pro\/api\/b\/tv\/[A-Za-z0-9_-]+\/2\/1\?multiLang=1$/);
    assert.match(resolverUrl('movie:603', 'cd'.repeat(32), 1_700_000_000_000), /^https:\/\/vidlink\.pro\/api\/b\/movie\/[A-Za-z0-9_-]+\?multiLang=1$/);
});

test('queue: never-probed first, then most stale relative to tier; fresh proofs are left alone; shards partition the library', () => {
    const items = [movie(1, 90), movie(2, 1), movie(3, 90), movie(4, 1), movie(5, 1)];
    const records = {
        'movie:1': { ok: true, at: NOW - 6 * H },    // hot, 6h/4h = 1.5
        'movie:2': { ok: true, at: NOW - 20 * H },   // tail, 20/24 = 0.83
        'movie:3': { ok: true, at: NOW - 1 * H },    // proven an hour ago: skipped
        'movie:4': { ok: true, at: NOW - 30 * H }    // tail, 30/24 = 1.25
    };                                               // movie:5 never probed
    const queue = buildQueue(items, records, NOW, 0, 1);
    assert.deepEqual(queue.map(task => task.item.id), [5, 1, 4, 2]);
    assert.equal(targetFor(movie(9, 90)), HOT_TARGET_MS); assert.equal(targetFor(movie(9, 2)), TAIL_TARGET_MS);
    const all = Array.from({ length: 5000 }, (_, i) => movie(i));
    const parts = Array.from({ length: 12 }, (_, s) => buildQueue(all, {}, NOW, s, 12).length);
    assert.equal(parts.reduce((a, b) => a + b, 0), 5000);
    assert.ok(Math.max(...parts) - Math.min(...parts) < 120, 'balanced shards');
    assert.equal(MIN_RECHECK_MS, 2 * H); assert.ok(hashKey('movie:1') >= 0);
});

test('series probe two seasons (first + latest) however long the show; verdict rules', () => {
    assert.deepEqual(seasonsToProbe(show(1, [1, 2, 3, 4, 5, 6])), [1, 6]);
    assert.deepEqual(seasonsToProbe(show(1, [3])), [3]);
    assert.deepEqual(seasonsToProbe({ id: 1, media_type: 'tv' }), [1]);
    const dead = season => ({ season, state: 'dead', reason: 'no-stream' }), alive = season => ({ season, state: 'alive' }), unknown = season => ({ season, state: 'limited' });
    assert.deepEqual(titleVerdict([alive(1), alive(6)]), { ok: true, seasonsDead: [] });
    assert.deepEqual(titleVerdict([alive(1), dead(6)]), { ok: true, seasonsDead: [6] });
    assert.deepEqual(titleVerdict([dead(1), dead(6)]), { ok: false, reason: 'no-stream', seasonsDead: [] });
    assert.equal(titleVerdict([dead(1), unknown(6)]), null);       // mixed with an unknown: prove nothing
    assert.equal(titleVerdict([unknown(1)]), null);
});

test('feed: removes proven-dead titles, keeps alive and unproven ones, and never adds a title the scanner did not list', () => {
    const scannerItems = [movie(1), movie(2), movie(3), show(10), show(11)];
    const shardOutputs = [{ records: { 'movie:1': { ok: false, at: NOW - H, reason: 'no-stream' }, 'movie:2': { ok: true, at: NOW - H }, 'tv:10': { ok: false, at: NOW - H }, 'movie:999': { ok: false, at: NOW - H } } }];
    const feed = buildFeed({ scannerItems, shardOutputs, now: NOW });
    assert.deepEqual(feed.items.map(i => i.id).sort((a, b) => a - b), [2, 3, 11]);
    assert.deepEqual(feed.hidden.map(h => h.key).sort(), ['movie:1', 'tv:10']);
    assert.deepEqual(Object.keys(feed.publishedRecords).sort(), ['movie:1', 'tv:10']);                      // the TV is told what is dead
    assert.equal(feed.items.some(i => i.id === 999), false);
});

test('feed: the scanner proving a title again after our dead verdict wins; a dead verdict expires after 72h', () => {
    const redeemed = movie(1, 1, 0.5);                                               // scanner deep-verified 30 min ago
    const feed = buildFeed({ scannerItems: [redeemed, movie(2, 1, 100)], shardOutputs: [{ records: { 'movie:1': { ok: false, at: NOW - 3 * H }, 'movie:2': { ok: false, at: NOW - 80 * H } } }], now: NOW });
    assert.deepEqual(feed.items.map(i => i.id).sort(), [1, 2]);                      // 1 redeemed by the scanner; 2's verdict aged out
    assert.equal(DEAD_RETAIN_MS, 72 * H);
});

test('feed: a series with a dead season keeps its other seasons; all seasons dead hides it', () => {
    const feed = buildFeed({ scannerItems: [show(10, [1, 2, 3]), show(11, [2])], shardOutputs: [{ seasonDead: { 'tv:10': { at: NOW - H, seasons: [3] }, 'tv:11': { at: NOW - H, seasons: [2] } } }], now: NOW });
    assert.deepEqual(feed.items.find(i => i.id === 10).playable_seasons, [1, 2]);
    assert.equal(feed.items.some(i => i.id === 11), false);
    assert.equal(feed.hidden[0].reason, 'all-seasons-dead');
});

test('feed: a title the scanner let expire is carried only while we proved it recently and it was deep-verified within 14 days', () => {
    const old = movie(7, 5, 24 * 5);
    const kept = buildFeed({ scannerItems: [], previousItems: [old], previousState: { records: { 'movie:7': { ok: true, at: NOW - 10 * H } } }, now: NOW });
    assert.equal(kept.items.length, 1); assert.equal(kept.carried, 1);
    const stale = buildFeed({ scannerItems: [], previousItems: [old], previousState: { records: { 'movie:7': { ok: true, at: NOW - 100 * H } } }, now: NOW });
    assert.equal(stale.items.length, 0);
    const unproven = buildFeed({ scannerItems: [], previousItems: [old], now: NOW });
    assert.equal(unproven.items.length, 0);
});

test('feed: overviews keep their first 240 characters (Smart Search), and the episode proofs for listed series are republished', () => {
    assert.equal(slimItem(movie(1, 2)).overview, 'long text');
    const long = slimItem({ ...movie(1, 2), overview: 'x'.repeat(500) }).overview;
    assert.equal(long.length, OVERVIEW_MAX); assert.ok(long.endsWith('...'));
    const feed = buildFeed({ scannerItems: [show(10), movie(2)], scannerRecords: { 'tv:10:s1:e1': { ok: true, at: NOW - H, v: 2 }, 'tv:99:s1:e1': { ok: true, at: NOW - H, v: 2 }, 'movie:2': { ok: true, at: NOW - H } }, now: NOW });
    assert.deepEqual(Object.keys(feed.publishedRecords), ['tv:10:s1:e1']);
});

test('proof age counts only titles this repo proved alive', () => {
    const items = [movie(1, 80), movie(2, 1), movie(3, 1)];
    const age = proofAge(items, { 'movie:1': { ok: true, at: NOW - 3 * H }, 'movie:2': { ok: true, at: NOW - 20 * H } }, NOW, 15);
    assert.equal(age.unproven, 1); assert.equal(age.checkedTitles, 2); assert.equal(age.hotP95h, 3); assert.equal(age.p95h, 20);
});

test('feed: availability_at follows the freshest alive proof so the TV keeps trusting a title this repo keeps re-proving', () => {
    const item = movie(1, 1, 60);                                       // scanner deep proof is 60h old
    const feed = buildFeed({ scannerItems: [item], shardOutputs: [{ records: { 'movie:1': { ok: true, at: NOW - 2 * H } } }], now: NOW });
    assert.equal(feed.items[0].availability_at, NOW - 2 * H);
    const unproven = buildFeed({ scannerItems: [item], now: NOW });
    assert.equal(unproven.items[0].availability_at, item.availability_at);   // never invents a proof
});
