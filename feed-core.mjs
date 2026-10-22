/* Pure rules of the verified feed (no network), so they are unit-tested. The feed is the catalogue scanner's list MINUS
   whatever this repo has proven dead. It can only remove titles (plus keep a recently-proven one the scanner just let
   expire); it never adds a title the scanner did not list. */
const HOUR = 3600000;
export const HOT_POPULARITY = Number(process.env.HOT_POPULARITY || 15);   // top ~3,000 titles: what rails and search surface
export const HOT_TARGET_MS = 4 * HOUR;       // popular titles are re-proven every 4h
export const TAIL_TARGET_MS = 24 * HOUR;     // everything else daily
export const MIN_RECHECK_MS = 2 * HOUR;      // never re-probe something proven this recently just to stay busy
export const DEAD_RETAIN_MS = 72 * HOUR;     // a dead verdict keeps a title hidden (and is published to the TV) this long
export const CARRY_ALIVE_MS = 72 * HOUR;     // a title the scanner dropped stays if we proved it alive this recently...
export const CARRY_DEEP_MS = 14 * 24 * HOUR; // ...and the scanner deep-verified it within this window
export const OVERVIEW_MAX = 240;             // the TV already stores overviews at this length; Smart Search ranks on them, Details refetches the full text

export function hashKey(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h >>> 0);
}
export const keyOf = item => item.media_type + ':' + item.id;
export const targetFor = item => (Number(item && item.popularity) || 0) >= HOT_POPULARITY ? HOT_TARGET_MS : TAIL_TARGET_MS;

/* Probe order for one shard: never-probed first, then most stale relative to its own tier, most popular breaking ties.
   Rate limits make capacity vary run to run; ordering by staleness means the least-proven titles are always served first
   and a slow run degrades gracefully instead of leaving a whole wave unchecked. */
export function buildQueue(items, records, now, shard, shardTotal) {
    const queue = [];
    for (const item of items) {
        const key = keyOf(item);
        if (hashKey(key) % shardTotal !== shard) continue;
        const last = Number(records[key] && records[key].at) || 0;
        if (last && now - last < MIN_RECHECK_MS) continue;
        queue.push({ key, item, last, stale: last ? (now - last) / targetFor(item) : Infinity, popularity: Number(item.popularity) || 0 });
    }
    return queue.sort((a, b) => b.stale - a.stale || b.popularity - a.popularity);
}

/* Which seasons to probe for a series: first and latest playable season, episode 1 (two requests however long the show). */
export function seasonsToProbe(item) {
    const seasons = Array.isArray(item.playable_seasons) && item.playable_seasons.length ? item.playable_seasons : [1];
    return [...new Set([seasons[0], seasons[seasons.length - 1]])];
}

/* Fold one probe round (per-season states) into a verdict for the title.
   dead = every probed season is dead; seasonsDead = probed seasons that are dead while another still plays. */
export function titleVerdict(states) {
    const dead = states.filter(entry => entry.state === 'dead'), alive = states.filter(entry => entry.state === 'alive');
    if (alive.length) return { ok: true, seasonsDead: dead.map(entry => entry.season).filter(Number.isFinite) };
    if (dead.length && dead.length === states.length) return { ok: false, reason: dead[0].reason || 'no-stream', seasonsDead: [] };
    return null; // rate-limited / outage / mixed unknown: proves nothing, never hides a title
}

export function slimItem(item) {
    const copy = { ...item };
    if (typeof copy.overview === 'string' && copy.overview.length > OVERVIEW_MAX) copy.overview = copy.overview.slice(0, OVERVIEW_MAX - 3) + '...';
    return copy;
}

/* Merge scanner items + previous feed + this run's probes into the next feed. */
export function buildFeed({ scannerItems, scannerRecords = {}, previousItems = [], previousState = {}, shardOutputs = [], now = Date.now() }) {
    const records = {}, seasonDead = {};
    const take = (key, rec) => { if (rec && typeof rec.ok === 'boolean' && Number.isFinite(rec.at) && (!records[key] || rec.at >= records[key].at)) records[key] = { ok: rec.ok, at: rec.at, ...(rec.reason ? { reason: rec.reason } : {}) }; };
    for (const [key, rec] of Object.entries(previousState.records || {})) take(key, rec);
    for (const [key, entry] of Object.entries(previousState.seasonDead || {})) if (entry && Array.isArray(entry.seasons)) seasonDead[key] = entry;
    for (const out of shardOutputs) {
        for (const [key, rec] of Object.entries(out.records || {})) take(key, rec);
        for (const [key, entry] of Object.entries(out.seasonDead || {})) if (entry && Array.isArray(entry.seasons) && (!seasonDead[key] || entry.at >= seasonDead[key].at)) seasonDead[key] = entry;
    }

    const byKey = new Map();
    for (const item of scannerItems) byKey.set(keyOf(item), { item, source: 'scanner' });
    for (const item of previousItems) {
        const key = keyOf(item);
        if (byKey.has(key)) continue;
        const rec = records[key], deepAt = Number(item.availability_at) || 0;
        // The scanner let this title expire, but we proved it alive recently and the scanner deep-verified it not long ago.
        if (rec && rec.ok && now - rec.at < CARRY_ALIVE_MS && now - deepAt < CARRY_DEEP_MS) byKey.set(key, { item, source: 'carried' });
    }

    const items = [], hidden = [];
    for (const [key, entry] of byKey) {
        const rec = records[key];
        const deepAt = Number(entry.item.availability_at) || 0;
        // Dead unless the scanner has deep-verified it again since our dead verdict (its newer proof wins).
        if (rec && rec.ok === false && now - rec.at < DEAD_RETAIN_MS && rec.at >= deepAt) { hidden.push({ key, at: rec.at, reason: rec.reason }); continue; }
        let item = slimItem(entry.item);
        // The TV trusts a title for 3 days from availability_at, so it must follow the freshest ALIVE proof from either repo.
        if (rec && rec.ok && rec.at > deepAt) item.availability_at = rec.at;
        const sd = seasonDead[key];
        if (sd && item.media_type === 'tv' && Array.isArray(item.playable_seasons) && now - sd.at < DEAD_RETAIN_MS && sd.at >= deepAt) {
            const keep = item.playable_seasons.filter(season => !sd.seasons.includes(season));
            if (!keep.length) { hidden.push({ key, at: sd.at, reason: 'all-seasons-dead' }); continue; }
            item = { ...item, playable_seasons: keep };
        }
        items.push(item);
    }
    items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || a.id - b.id);

    // Published to the TV: dead verdicts (so a TV that still holds a removed title drops it) + the scanner's episode proofs.
    const published = {};
    for (const h of hidden) published[h.key] = { ok: false, at: h.at };
    const listed = new Set(items.filter(i => i.media_type === 'tv').map(keyOf));
    for (const [key, rec] of Object.entries(scannerRecords)) {
        if (!rec || !rec.ok || !key.includes(':s')) continue;
        if (listed.has(key.split(':s')[0])) published[key] = { ok: true, at: rec.at, v: rec.v };
    }

    // Forget what is no longer useful so state stays small: old alive records, old dead records, expired season verdicts.
    const keep = {};
    for (const [key, rec] of Object.entries(records)) {
        if (rec.ok ? now - rec.at < 7 * 24 * HOUR : now - rec.at < DEAD_RETAIN_MS) keep[key] = rec;
    }
    const keepSeasons = {};
    for (const [key, entry] of Object.entries(seasonDead)) if (now - entry.at < DEAD_RETAIN_MS) keepSeasons[key] = entry;
    return { items, hidden, publishedRecords: published, state: { records: keep, seasonDead: keepSeasons }, carried: [...byKey.values()].filter(e => e.source === 'carried').length };
}

export function proofAge(items, records, now, hotPopularity = HOT_POPULARITY) {
    const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const all = [], hot = [];
    let unproven = 0;
    for (const item of items) {
        const rec = records[keyOf(item)];
        if (!rec || !rec.ok) { unproven++; continue; }
        const age = (now - rec.at) / HOUR;
        all.push(age);
        if ((Number(item.popularity) || 0) >= hotPopularity) hot.push(age);
    }
    all.sort((a, b) => a - b); hot.sort((a, b) => a - b);
    const r = v => Math.round(v * 10) / 10;
    return { checkedTitles: all.length, unproven, p50h: r(pct(all, 0.5)), p95h: r(pct(all, 0.95)), hotTitles: hot.length, hotP50h: r(pct(hot, 0.5)), hotP95h: r(pct(hot, 0.95)) };
}
