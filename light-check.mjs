import { Buffer } from 'node:buffer';

/* The fast proof: resolver request + 4 KB CDN manifest/media header check.
   Classification matches the TV's own open-time pre-flight and catches dead CDNs (403/404/428/not-media) and trailers. */
export function classifyResolver(status, data) {
    if (!status || status === 429 || status >= 500) return { state: status === 429 ? 'limited' : 'unknown' };
    if (status !== 200) return [400, 403, 404, 410, 422, 428].includes(status) ? { state: 'dead', reason: 'resolver-' + status } : { state: 'unknown' };
    const stream = data && data.stream;
    if (!stream) return { state: 'dead', reason: 'no-stream' };
    const qualities = stream.qualities || {};
    const qEntry = Object.values(qualities).find(q => q && q.url);
    const url = qEntry?.url || (typeof stream.playlist === 'string' ? stream.playlist : '');
    if (!url) return { state: 'dead', reason: 'no-stream' };
    try { if (new URL(url).protocol !== 'https:') return { state: 'dead', reason: 'insecure' }; } catch (e) { return { state: 'dead', reason: 'bad-url' }; }
    const duration = Number(stream.playbackMetadata && stream.playbackMetadata.duration) || Number(qEntry && qEntry.duration) || 0;
    if (duration > 0 && duration < 8 * 60) return { state: 'dead', reason: 'too-short' };
    return {
        state: 'alive',
        source: {
            url,
            type: (qEntry && qEntry.type) || stream.type || '',
            headers: (qEntry && qEntry.headers) || stream.playlistHeaders || null
        }
    };
}

const HEADERS = {
    Referer: 'https://vidlink.pro/', Origin: 'https://vidlink.pro',
    'User-Agent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
    'X-Playback-Environment': 'dash-hevc'
};
const ONEROOM_UA = 'com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)';

export function looksLikeMedia(bytes) {
    if (!bytes || bytes.length < 188) return false;
    const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
    if (/^\s*(<|\{|#EXTM3U)/i.test(head)) return false;
    if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true;
    const box = Buffer.from(bytes.subarray(4, 8)).toString('latin1');
    if (/^(ftyp|styp|moof|moov|sidx|mdat|free|emsg|prft)$/.test(box)) return true;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return true;
    return false;
}

export function firstHlsChildUri(manifestText, hitEof = true) {
    if (!manifestText) return null;
    const lines = String(manifestText).split(/\r?\n/);
    if (!hitEof && lines.length > 1) lines.pop();
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (!line.startsWith('#')) return line;
    }
    const completeText = lines.join('\n');
    const mapMatch = completeText.match(/#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/i);
    return mapMatch ? mapMatch[1].trim() : null;
}

function resolveChildUrl(rawUri, parentUrl) {
    if (!rawUri || rawUri.includes('$') || rawUri.includes('{$')) return null;
    try {
        const child = new URL(rawUri, parentUrl.href);
        if (child.protocol !== 'https:') return null;
        if (/^hcdn\d*\.hakunaymatata\.com$/i.test(child.hostname)) child.hostname = 'hcdn5.hakunaymatata.com';
        if (child.hostname === parentUrl.hostname) {
            for (const key of ['Policy', 'Signature', 'Key-Pair-Id', 'token', 'expires', 'hdnts']) {
                if (parentUrl.searchParams.has(key) && !child.searchParams.has(key)) {
                    child.searchParams.set(key, parentUrl.searchParams.get(key));
                }
            }
        }
        return child;
    } catch (e) {
        return null;
    }
}

function buildProbeHeaders(urlObj, source, rangeSpec) {
    const isHakunaDirect = urlObj.hostname.endsWith('hakunaymatata.com') && urlObj.hostname !== 'sacdn.hakunaymatata.com';
    return isHakunaDirect
        ? {
            'User-Agent': (source && source.headers && (source.headers['User-Agent'] || source.headers['user-agent'])) || ONEROOM_UA,
            Accept: '*/*',
            Range: rangeSpec
        }
        : { ...HEADERS, Range: rangeSpec };
}

async function readPrefixBytes(res, maxBytes) {
    const reader = res.body?.getReader?.();
    if (!reader) return { bytes: null, hitEof: true };
    const parts = [];
    let size = 0;
    let hitEof = false;
    try {
        while (size < maxBytes) {
            const chunk = await reader.read();
            if (chunk.done) { hitEof = true; break; }
            parts.push(chunk.value);
            size += chunk.value.byteLength;
        }
        return { bytes: Buffer.concat(parts.map(p => Buffer.from(p))), hitEof };
    } finally {
        try { await reader.cancel(); } catch (e) {}
    }
}

function looksLikeBadSegment(bytes, contentType, isEncrypted) {
    if (/text\/html|application\/json|application\/xml|text\/xml|text\/plain/i.test(contentType || '')) return true;
    if (!bytes || bytes.length === 0) return true;
    const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 96))).toString('latin1').trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml\b|<Error\b|\{\s*"(?:error|message|status|code)"\s*:)/i.test(head)) return true;
    if (!isEncrypted && bytes.length >= 188 && !looksLikeMedia(bytes)) return true;
    return false;
}

async function probeMediaSegment(segUrl, source, isEncrypted, fetchImpl, timeoutMs) {
    let segRes;
    try {
        segRes = await fetchImpl(segUrl.href, {
            headers: buildProbeHeaders(segUrl, source, 'bytes=0-1023'),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow'
        });
        if (segRes.status === 429) return { state: 'limited' };
        if ([400, 401, 403, 404, 410, 416, 422, 428].includes(segRes.status)) return { state: 'dead', reason: 'seg-' + segRes.status };
        if (!segRes.ok && segRes.status !== 206) return { state: 'unknown' };
        const { bytes } = await readPrefixBytes(segRes, 1024);
        if (!bytes) return { state: 'alive' };
        if (looksLikeBadSegment(bytes, segRes.headers?.get?.('Content-Type'), isEncrypted)) {
            return { state: 'dead', reason: 'bad-seg' };
        }
        return { state: 'alive' };
    } catch (e) {
        return { state: 'unknown' };
    } finally {
        try { await segRes?.body?.cancel?.(); } catch (e) {}
    }
}

export async function verifyStreamSource(source, { fetchImpl = fetch, timeoutMs = 9000 } = {}) {
    if (!source || !source.url) return { state: 'dead', reason: 'no-stream' };
    let res;
    try {
        const target = new URL(source.url);
        if (target.protocol !== 'https:') return { state: 'dead', reason: 'insecure' };
        if (/^hcdn\d*\.hakunaymatata\.com$/i.test(target.hostname)) target.hostname = 'hcdn5.hakunaymatata.com';
        const cookie = source.headers && (source.headers.Cookie || source.headers.cookie);
        if (cookie) {
            for (const part of cookie.split(';')) {
                const sep = part.indexOf('=');
                if (sep < 0) continue;
                const names = { 'CloudFront-Policy': 'Policy', 'CloudFront-Signature': 'Signature', 'CloudFront-Key-Pair-Id': 'Key-Pair-Id' };
                const mapped = names[part.slice(0, sep).trim()];
                if (mapped) target.searchParams.set(mapped, part.slice(sep + 1).trim());
            }
        }
        const probeHeaders = buildProbeHeaders(target, source, 'bytes=0-8191');
        res = await fetchImpl(target.href, { headers: probeHeaders, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (res.status === 429) return { state: 'limited' };
        if ([400, 401, 403, 404, 410, 416, 422, 428].includes(res.status)) return { state: 'dead', reason: 'cdn-' + res.status };
        if (!res.ok && res.status !== 206) return { state: 'unknown' };
        const { bytes, hitEof } = await readPrefixBytes(res, 8192);
        if (!bytes) return { state: 'alive' };
        const isDash = source.type === 'dash' || /\.mpd(?:[?#]|$)/i.test(target.pathname);
        const isHls = source.type === 'hls' || /\.m3u8(?:[?#]|$)/i.test(target.pathname);
        if (isDash) {
            const text = bytes.toString('utf8');
            if (!/<(?:\w+:)?MPD\b/i.test(text)) return { state: 'dead', reason: 'bad-mpd' };
            const baseMatch = (hitEof || text.includes('</BaseURL>')) ? text.match(/<BaseURL>\s*(https:\/\/[^<\s$]+)\s*<\/BaseURL>/i) : null;
            if (baseMatch) {
                const mediaUrl = resolveChildUrl(baseMatch[1], target);
                if (mediaUrl && !/\/$/.test(mediaUrl.pathname)) {
                    const hasDrm = /<(?:\w+:)?ContentProtection\b/i.test(text);
                    return await probeMediaSegment(mediaUrl, source, hasDrm, fetchImpl, timeoutMs);
                }
            }
            return { state: 'alive' };
        }
        if (isHls) {
            const text = bytes.toString('utf8').trim();
            if (!/^#EXTM3U/i.test(text)) return { state: 'dead', reason: 'bad-m3u8' };
            const childUri = firstHlsChildUri(text, hitEof);
            if (!childUri) {
                return /#EXT-X-ENDLIST/i.test(text) ? { state: 'dead', reason: 'empty-m3u8' } : { state: 'alive' };
            }
            const childUrl = resolveChildUrl(childUri, target);
            if (!childUrl || /\.vtt(?:[?#]|$)/i.test(childUrl.pathname)) return { state: 'alive' };
            let childRes;
            try {
                childRes = await fetchImpl(childUrl.href, {
                    headers: buildProbeHeaders(childUrl, source, 'bytes=0-8191'),
                    signal: AbortSignal.timeout(timeoutMs),
                    redirect: 'follow'
                });
                if (childRes.status === 429) return { state: 'limited' };
                if ([400, 401, 403, 404, 410, 416, 422, 428].includes(childRes.status)) return { state: 'dead', reason: 'seg-' + childRes.status };
                if (!childRes.ok && childRes.status !== 206) return { state: 'unknown' };
                const { bytes: childBytes, hitEof: childEof } = await readPrefixBytes(childRes, 8192);
                if (!childBytes) return { state: 'alive' };
                const childText = childBytes.toString('utf8').trim();
                if (/^#EXTM3U/i.test(childText)) {
                    const segUri = firstHlsChildUri(childText, childEof);
                    if (!segUri) {
                        return /#EXT-X-ENDLIST/i.test(childText) ? { state: 'dead', reason: 'empty-m3u8' } : { state: 'alive' };
                    }
                    const segUrl = resolveChildUrl(segUri, childUrl);
                    if (!segUrl || /\.vtt(?:[?#]|$)/i.test(segUrl.pathname)) return { state: 'alive' };
                    const childEncrypted = /#EXT-X-KEY:[^\r\n]*METHOD=(?!NONE)/i.test(childText);
                    return await probeMediaSegment(segUrl, source, childEncrypted, fetchImpl, timeoutMs);
                }
                const parentEncrypted = /#EXT-X-KEY:[^\r\n]*METHOD=(?!NONE)/i.test(text);
                if (looksLikeBadSegment(childBytes, childRes.headers?.get?.('Content-Type'), parentEncrypted)) {
                    return { state: 'dead', reason: 'bad-seg' };
                }
                return { state: 'alive' };
            } catch (e) {
                return { state: 'unknown' };
            } finally {
                try { await childRes?.body?.cancel?.(); } catch (e) {}
            }
        }
        if (/html|json|text\//i.test(res.headers?.get?.('Content-Type') || '')) return { state: 'dead', reason: 'not-media' };
        return looksLikeMedia(bytes) ? { state: 'alive' } : { state: 'dead', reason: 'not-media' };
    } catch (e) {
        return { state: 'unknown' };
    } finally {
        try { await res?.body?.cancel?.(); } catch (e) {}
    }
}

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
