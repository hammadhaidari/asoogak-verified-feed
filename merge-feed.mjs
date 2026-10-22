import fs from 'node:fs';
import path from 'node:path';
import { buildFeed, proofAge, feedSummary, keyOf } from './feed-core.mjs';

const SOURCE_URL = (process.env.SOURCE_CATALOGUE_URL || '').trim();
const PREV_FEED_URL = (process.env.FEED_CATALOGUE_URL || '').trim();
const PREV_STATE_URL = (process.env.FEED_STATE_URL || '').trim();
const ARTIFACTS = process.env.ARTIFACTS_DIR || 'artifacts';
const OUT = process.env.OUTPUT_DIR || 'dist';
const MAX_NEW_HIDDEN_SHARE = Number(process.env.MAX_NEW_HIDDEN_SHARE || 0.08);

async function getJson(url, ms = 120000) {
    if (!url) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { const res = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (res.ok) return await res.json(); } catch (e) {}
        await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
    }
    return null;
}
function findOutputs(dir) {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...findOutputs(full));
        else if (/^probe-output-\d+\.json$/.test(entry.name)) found.push(full);
    }
    return found;
}

async function main() {
    const now = Date.now();
    const source = await getJson(SOURCE_URL);
    // Never publish from a broken or truncated source: the previous feed simply stays up.
    if (!source || !Array.isArray(source.items) || source.items.length < 1000) throw new Error('Scanner catalogue unavailable or too small; keeping the previous feed');
    const previousFeed = await getJson(PREV_FEED_URL, 90000);
    const previousState = (await getJson(PREV_STATE_URL, 90000)) || {};
    const outputs = findOutputs(ARTIFACTS).map(file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }).filter(Boolean);

    const stats = { shards: outputs.length, probed: 0, alive: 0, dead: 0, limited: 0, unknown: 0, hotProbed: 0, seasonsDead: 0, left: 0 };
    for (const out of outputs) for (const name of Object.keys(stats)) if (name !== 'shards') stats[name] += Number(out.stats && out.stats[name]) || 0;

    const feed = buildFeed({ scannerItems: source.items, scannerRecords: source.records || {}, previousItems: previousFeed && previousFeed.items || [], previousState, shardOutputs: outputs, now });

    // Safety valve: a run that suddenly hides far more than usual is a provider/network incident, not real removals.
    const previousHidden = new Set(Object.entries(previousFeed && previousFeed.records || {}).filter(([k, r]) => r && r.ok === false).map(([k]) => k));
    const newlyHidden = feed.hidden.filter(h => !previousHidden.has(h.key));
    let anomaly = null;
    if (newlyHidden.length > Math.max(150, source.items.length * MAX_NEW_HIDDEN_SHARE)) {
        anomaly = `Run would newly hide ${newlyHidden.length} titles (> ${Math.round(MAX_NEW_HIDDEN_SHARE * 100)}%); not publishing this run's dead verdicts.`;
        console.error('ANOMALY: ' + anomaly);
        // Keep previous feed's hidden set only; this run's fresh dead verdicts are discarded.
        const safe = buildFeed({ scannerItems: source.items, scannerRecords: source.records || {}, previousItems: previousFeed && previousFeed.items || [], previousState, shardOutputs: [], now });
        Object.assign(feed, safe);
    }

    const movieCount = feed.items.filter(i => i.media_type === 'movie').length, tvCount = feed.items.length - movieCount;
    const age = proofAge(feed.items, feed.state.records, now);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'catalogue.json'), JSON.stringify({
        updatedAt: now, paginated: false, totalPlayable: feed.items.length, movieCount, tvCount,
        deepVerified: feed.items.filter(i => Number(i.verified_v) >= 2).length, episodeVerdicts: Object.keys(feed.publishedRecords).filter(k => k.includes(':s')).length,
        summary: feedSummary({ items: feed.items, hidden: feed.hidden, age, stats, now }),
        records: feed.publishedRecords, items: feed.items, source: { updatedAt: source.updatedAt, totalPlayable: source.totalPlayable }
    }));
    const history = [...(Array.isArray(previousState.history) ? previousState.history : []), {
        at: now, shards: stats.shards, probed: stats.probed, dead: stats.dead, limited: stats.limited, hidden: feed.hidden.length,
        total: feed.items.length, hotP95h: age.hotP95h, p95h: age.p95h, unproven: age.unproven
    }].slice(-96);
    fs.writeFileSync(path.join(OUT, 'feed-state.json'), JSON.stringify({ updatedAt: now, records: feed.state.records, seasonDead: feed.state.seasonDead, lastRun: stats, proofAge: age, hiddenNow: feed.hidden.length, carried: feed.carried, anomaly, history }));
    console.log(`Verified feed: ${feed.items.length} alive-listed (${movieCount} movies, ${tvCount} series) from ${source.items.length} scanner titles; ${feed.hidden.length} hidden dead (${newlyHidden.length} new this run); carried ${feed.carried}.`);
    console.log(`Run: ${stats.probed} probed (${stats.alive} alive, ${stats.dead} dead), ${stats.limited} rate-limited, ${stats.left} left across ${stats.shards} shards. Proof age: median ${age.p50h}h, p95 ${age.p95h}h, popular p95 ${age.hotP95h}h, ${age.unproven} not yet proven by this repo.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(err); process.exit(1); });
