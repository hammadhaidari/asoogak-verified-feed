import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import { buildQueue, seasonsToProbe, titleVerdict, keyOf } from './feed-core.mjs';
import { lightProbe, verifyStreamSource } from './light-check.mjs';

const SHARD = Math.max(0, Number(process.env.SHARD_INDEX || 0));
const SHARD_TOTAL = Math.max(1, Number(process.env.SHARD_TOTAL || 12));
const SCAN_MS = Math.max(30000, Number(process.env.SCAN_DURATION_MS || 1200000));
const WORKERS = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 4));
const RESOLVER_KEY = (process.env.RESOLVER_KEY || '').trim();
const PROXIES = (process.env.PROXY_URL || '').split(',').map(s => s.trim()).filter(Boolean);
const SOURCE_URL = (process.env.SOURCE_CATALOGUE_URL || '').trim();
const STATE_URL = (process.env.FEED_STATE_URL || '').trim();
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

export function resolverUrl(key, secret, now = Date.now()) {
    const match = /^(movie|tv):(\d+)(?::s(\d+):e(\d+))?$/.exec(key);
    const identity = new TextEncoder().encode(match[2]);
    const message = new Uint8Array(identity.length + 8);
    message.set(identity);
    new DataView(message.buffer).setBigUint64(identity.length, BigInt(Math.floor(now / 1000) + 480), false);
    const encrypted = nacl.secretbox(message, new Uint8Array(24), Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16)));
    const token = Buffer.from(new Uint8Array([...new Uint8Array(24), ...encrypted])).toString('base64url');
    return 'https://vidlink.pro/api/b/' + match[1] + '/' + token + (match[1] === 'tv' ? '/' + (match[3] || 1) + '/' + (match[4] || 1) : '') + '?multiLang=1';
}

async function getJson(url, ms = 90000) {
    if (!url) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { const res = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (res.ok) return await res.json(); } catch (e) {}
        await sleep(2000 * (attempt + 1));
    }
    return null;
}

async function run() {
    const started = Date.now();
    const timeLeft = () => SCAN_MS - (Date.now() - started);
    const source = await getJson(SOURCE_URL);
    const state = (await getJson(STATE_URL, 30000)) || { records: {} };
    const items = source && Array.isArray(source.items) ? source.items : [];
    const stats = { shard: SHARD, queued: 0, probed: 0, alive: 0, dead: 0, limited: 0, unknown: 0, hotProbed: 0, seasonsDead: 0, gapMs: 0, sourceItems: items.length };
    const records = {}, seasonDead = {};
    const queue = buildQueue(items, state.records || {}, Date.now(), SHARD, SHARD_TOTAL);
    stats.queued = queue.length;

    // Adaptive pacing (AIMD) shared by this runner's workers: widen on 429, narrow on success.
    let gap = 500, nextAt = 0, cooldownUntil = 0;
    const proxyCursor = { n: SHARD };
    async function slot() {
        const wait = Math.max(nextAt, cooldownUntil) - Date.now();
        nextAt = Math.max(Date.now(), nextAt) + gap;
        if (wait > 0) await sleep(wait);
    }
    async function probe(key) {
        for (let attempt = 0; attempt < 3 && timeLeft() > 12000; attempt++) {
            await slot();
            const result = await lightProbe(key, { secret: RESOLVER_KEY, resolverUrl, proxies: PROXIES, proxyCursor });
            if (result.state === 'limited') { stats.limited++; gap = Math.min(8000, Math.round(gap * 1.6)); cooldownUntil = Math.max(cooldownUntil, Date.now() + 3000 + attempt * 3000); continue; }
            gap = Math.max(350, Math.round(gap * 0.93)); stats.gapMs = gap;
            if (result.state === 'unknown') { await sleep(1000); continue; }
            if (result.state === 'alive' && result.source) {
                const cdn = await verifyStreamSource(result.source);
                if (cdn.state === 'dead') return cdn;
                if (cdn.state !== 'alive') { await sleep(800); continue; }
            }
            return result;
        }
        return { state: 'unknown' };
    }
    async function checkTitle(task) {
        const { item, key } = task;
        const now = Date.now();
        if (item.media_type === 'movie') {
            const result = await probe(key);
            if (result.state === 'unknown') { stats.unknown++; return; }
            records[key] = { ok: result.state === 'alive', at: now, ...(result.reason ? { reason: result.reason } : {}) };
            return;
        }
        const states = [];
        for (const season of seasonsToProbe(item)) {
            if (timeLeft() < 12000) return;
            const result = await probe(`${key}:s${season}:e1`);
            states.push({ season, state: result.state, reason: result.reason });
        }
        const verdict = titleVerdict(states);
        if (!verdict) { stats.unknown++; return; }
        records[key] = { ok: verdict.ok, at: now, ...(verdict.reason ? { reason: verdict.reason } : {}) };
        if (verdict.ok && verdict.seasonsDead.length) { seasonDead[key] = { at: now, seasons: verdict.seasonsDead }; stats.seasonsDead += verdict.seasonsDead.length; }
    }
    async function worker() {
        while (timeLeft() > 12000) {
            const task = queue.shift();
            if (!task) break;
            await checkTitle(task);
            const rec = records[task.key];
            if (rec) { stats.probed++; if (rec.ok) stats.alive++; else stats.dead++; if ((Number(task.item.popularity) || 0) >= 15) stats.hotProbed++; }
        }
    }
    await Promise.all(Array.from({ length: WORKERS }, worker));
    stats.left = queue.length;
    fs.writeFileSync(`probe-output-${SHARD}.json`, JSON.stringify({ shard: SHARD, updatedAt: Date.now(), stats, records, seasonDead }));
    console.log(`Shard ${SHARD} complete:`, JSON.stringify(stats));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (!RESOLVER_KEY) { console.error('Missing RESOLVER_KEY'); process.exit(1); }
    run().catch(err => { console.error(err); process.exit(1); });
}
