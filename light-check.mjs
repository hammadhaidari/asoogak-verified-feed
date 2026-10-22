/* The cheap proof: ONE resolver request per title (two for a series). Every dead title seen so far dies at exactly this
   step (the provider answers "no stream"), so this finds them at a quarter of the cost of the scanner's deep check.
   Classification matches the TV's own open-time pre-flight. */
export function classifyResolver(status, data) {
    if (!status || status === 429 || status >= 500) return { state: status === 429 ? 'limited' : 'unknown' };
    if (status !== 200) return [400, 403, 404, 410, 422, 428].includes(status) ? { state: 'dead', reason: 'resolver-' + status } : { state: 'unknown' };
    const stream = data && data.stream;
    if (!stream) return { state: 'dead', reason: 'no-stream' };
    const qualities = stream.qualities || {};
    const url = Object.values(qualities).find(q => q && q.url)?.url || (typeof stream.playlist === 'string' ? stream.playlist : '');
    if (!url) return { state: 'dead', reason: 'no-stream' };
    try { if (new URL(url).protocol !== 'https:') return { state: 'dead', reason: 'insecure' }; } catch (e) { return { state: 'dead', reason: 'bad-url' }; }
    return { state: 'alive' };
}

const HEADERS = {
    Referer: 'https://vidlink.pro/', Origin: 'https://vidlink.pro',
    'User-Agent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
    'X-Playback-Environment': 'dash-hevc'
};

/* One request; if this runner IP is throttled (429/network error) retry once through a proxy egress when one is configured. */
export async function lightProbe(key, { secret, resolverUrl, fetchImpl = fetch, proxies = [], proxyCursor = { n: 0 }, timeoutMs = 11000 }) {
    const target = resolverUrl(key, secret);
    const attempt = async url => {
        try {
            const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
            let data = null;
            if (res.status === 200) { try { data = await res.json(); } catch (e) { return { state: 'unknown' }; } }
            else { try { await res.body?.cancel(); } catch (e) {} }
            return classifyResolver(res.status, data);
        } catch (e) { return { state: 'unknown' }; }
    };
    let result = await attempt(target);
    if ((result.state === 'limited' || result.state === 'unknown') && proxies.length) {
        const base = proxies[proxyCursor.n++ % proxies.length];
        result = await attempt(base + encodeURIComponent(target) + '&base=' + encodeURIComponent('https://vidlink.pro'));
    }
    return result;
}
