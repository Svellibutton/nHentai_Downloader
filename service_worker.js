
// service_worker.js — probe CDN (i1..i9) via page 1, download + zip, progress events

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "countWords",
    title: "Count words on this page",
    contexts: ["page", "selection"],
    documentUrlPatterns: ["https://nhentai.net/*"]
  });
});

function sanitizeFilename(name) {
  const fallback = 'gallery';
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return cleaned || fallback;
}

function sendProgress(stage, pct, note) {
  chrome.runtime.sendMessage({ type: 'progress', stage, pct, note }).catch?.(()=>{});
}

const CDN_HOSTS = ['i1','i2','i3','i4','i5','i6','i7','i8','i9'].map(s => `${s}.nhentai.net`);
const tokenToExt = (t) => ({ j: 'jpg', p: 'png', g: 'gif', w: 'webp' }[t] || 'jpg');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'startDownload') {
    (async () => {
      try {
        sendProgress('Detecting gallery...', 0);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const g = normalizeTabUrlToGallery(tab?.url);
        if (!g) throw new Error('Not on a nhentai gallery page.');

        const galleryId = extractGalleryId(g);
        const apiUrl = `https://nhentai.net/api/gallery/${galleryId}`;

        sendProgress('Fetching metadata...', 5);
        const meta = await (await fetch(apiUrl, { cache: 'no-store' })).json();

        const mediaId = meta.media_id;
        const pages = meta.images?.pages || [];
        if (!mediaId || !pages.length) throw new Error('Gallery metadata missing.');

        // Determine expected extension for page 1 from API token
        const firstExt = tokenToExt(pages[0]?.t || 'j');

        // Probe CDN for page 1
        sendProgress('Finding gallery CDN...', 8);
        const probe = await probeCdnForFirstImage(mediaId, firstExt);
        if (!probe.host || !probe.data) throw new Error('Could not detect a working CDN host.');

        const chosenHost = probe.host;
        const blobs = [];
        blobs.push({ name: `001.${probe.ext}`, data: probe.data });

        // Build desired extensions for remaining pages
        const desiredExts = pages.map(p => tokenToExt(p.t || 'j'));

        // Fetch remaining images from the chosen host with per-page extension fallback
        for (let i = 1; i < pages.length; i++) {
          const pageNum = i + 1;
          const wantExt = desiredExts[i];
          sendProgress(`Downloading images (${pageNum}/${pages.length})...`, Math.floor((i / pages.length) * 80) + 10);

          const { data, usedExt } = await fetchFromSingleCdnWithExtFallbacks(chosenHost, mediaId, pageNum, wantExt);
          if (!data) throw new Error(`Failed to fetch page ${pageNum} from ${chosenHost}`);
          blobs.push({ name: `${String(pageNum).padStart(3, '0')}.${usedExt}`, data });
        }

        sendProgress('Zipping files...', 92);
        const zipData = buildZipStore(blobs);
        const dataUrl = 'data:application/zip;base64,' + u8ToBase64(zipData);

        // Use textbox value or fallback to gallery title
        let filename = msg.filename && msg.filename.trim();
        if (!filename) {
          filename = meta.title?.english || meta.title?.japanese || meta.title?.pretty || `gallery_${galleryId}`;
        }
        filename = sanitizeFilename(filename) + '.zip';

        sendProgress('Saving ZIP...', 97);
        await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false
        });

        sendProgress('Done!', 100, 'Download started via browser.');
        sendResponse({ ok: true });
      } catch (e) {
        console.error(e);
        sendProgress('Error', 100, String(e));
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

async function probeCdnForFirstImage(mediaId, wantExt) {
  const FALLBACK_EXTS = [wantExt, 'jpg', 'png', 'webp', 'gif'].filter((v, i, a) => a.indexOf(v) === i);
  for (const host of CDN_HOSTS) {
    for (const ext of FALLBACK_EXTS) {
      const url = `https://${host}/galleries/${mediaId}/1.${ext}`;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          return { host, ext, data: new Uint8Array(ab) };
        }
      } catch (e) { /* keep trying */ }
    }
  }
  return { host: null, ext: wantExt, data: null };
}

async function fetchFromSingleCdnWithExtFallbacks(host, mediaId, pageNum, wantExt) {
  const FALLBACK_EXTS = [wantExt, 'jpg', 'png', 'webp', 'gif'].filter((v, i, a) => a.indexOf(v) === i);
  for (const ext of FALLBACK_EXTS) {
    const url = `https://${host}/galleries/${mediaId}/${pageNum}.${ext}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return { data: new Uint8Array(ab), usedExt: ext };
      }
    } catch (e) { /* try next */ }
  }
  return { data: null, usedExt: wantExt };
}

function normalizeTabUrlToGallery(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.hostname !== 'nhentai.net') return null;
    const m = url.pathname.match(/^\/g\/(\d+)(?:\/\d+)?\/?$/);
    if (m) return `https://nhentai.net/g/${m[1]}/`;
  } catch {}
  return null;
}
function extractGalleryId(galleryUrl) {
  const m = galleryUrl.match(/\/g\/(\d+)\//);
  if (!m) throw new Error('Cannot extract gallery id');
  return m[1];
}

// Convert Uint8Array -> base64 string (chunked)
function u8ToBase64(u8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

// ZIP (STORE) builder
function buildZipStore(files) {
  const enc = new TextEncoder();

  function crc32(buf) {
    let c = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
    }
    return (c ^ -1) >>> 0;
  }
  const CRC_TABLE = (() => {
    let table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)) >>> 0;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const compSize = data.byteLength;
    const uncompSize = data.byteLength;

    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    let p = 0;
    dv.setUint32(p, 0x04034b50, true); p += 4;
    dv.setUint16(p, 20, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint32(p, crc, true); p += 4;
    dv.setUint32(p, compSize, true); p += 4;
    dv.setUint32(p, uncompSize, true); p += 4;
    dv.setUint16(p, nameBytes.length, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    lh.set(nameBytes, 30);

    parts.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    p = 0;
    cdv.setUint32(p, 0x02014b50, true); p += 4;
    cdv.setUint16(p, 20, true); p += 2;
    cdv.setUint16(p, 20, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint32(p, crc, true); p += 4;
    cdv.setUint32(p, compSize, true); p += 4;
    cdv.setUint32(p, uncompSize, true); p += 4;
    cdv.setUint16(p, nameBytes.length, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint16(p, 0, true); p += 2;
    cdv.setUint32(p, 0, true); p += 4;
    cdv.setUint32(p, offset, true); p += 4;
    ch.set(nameBytes, 46);

    central.push(ch);
    offset += lh.length + data.length;
  }

  let centralSize = central.reduce((n, a) => n + a.length, 0);
  let centralOffset = offset;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  let ep = 0;
  edv.setUint32(ep, 0x06054b50, true); ep += 4;
  edv.setUint16(ep, 0, true); ep += 2;
  edv.setUint16(ep, 0, true); ep += 2;
  edv.setUint16(ep, files.length, true); ep += 2;
  edv.setUint16(ep, files.length, true); ep += 2;
  edv.setUint32(ep, centralSize, true); ep += 4;
  edv.setUint32(ep, centralOffset, true); ep += 4;
  edv.setUint16(ep, 0, true); ep += 2;

  const totalLen = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}
