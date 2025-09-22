// popup.js — clean build

const input = document.getElementById('note');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('ph');
const downloadBtn = document.getElementById('download');
const progressBar = document.getElementById('progressBar');
const stageText = document.getElementById('stageText');

// Persist text as the user types
input.addEventListener('input', () => {
  chrome.storage.sync.set({ storedText: input.value });
});

// Clear the textbox and storage on each popup open, then populate from API and set preview
document.addEventListener('DOMContentLoaded', () => {
  input.value = '';
  chrome.storage.sync.set({ storedText: '' });
  updatePreviewFromActiveTab();
});

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

function page1Url(galleryUrl) {
  if (!galleryUrl) return null;
  return galleryUrl.endsWith('/') ? galleryUrl + '1/' : galleryUrl + '/1/';
}

async function updatePreviewFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const g = normalizeTabUrlToGallery(tab?.url);
    if (!g) {
      showPlaceholder('Open a nhentai gallery tab to preview.');
      return;
    }

    // 1) Populate textbox from API: english -> japanese -> pretty
    const idMatch = g.match(/\/g\/(\d+)\//);
    if (idMatch) {
      const apiUrl = `https://nhentai.net/api/gallery/${idMatch[1]}`;
      try {
        const meta = await (await fetch(apiUrl, { cache: 'no-store' })).json();
        const title = meta?.title?.english || meta?.title?.japanese || meta?.title?.pretty || '';
        if (title) {
          input.value = title;
          chrome.storage.sync.set({ storedText: title });
        }
      } catch (e) {
        console.warn('Failed to fetch title from API', e);
      }
    }

    // 2) Preview image from page 1
    const page1 = page1Url(g);
    const res = await fetch(page1, { credentials: 'omit', cache: 'no-store' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let imgEl = doc.querySelector('img#image')
              || doc.querySelector('#image-container img')
              || doc.querySelector('img[class*="fit"], img[class*="lazy"]')
              || doc.querySelector('img');
    let src = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src');
    if (src && src.startsWith('//')) src = 'https:' + src;
    if (src) {
      preview.src = src;
      preview.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      showPlaceholder('Could not find page image.');
    }
  } catch (e) {
    console.error(e);
    showPlaceholder('Preview failed to load.');
  }
}

function showPlaceholder(text) {
  preview.removeAttribute('src');
  preview.style.display = 'none';
  placeholder.textContent = text || 'Preview will appear here';
  placeholder.style.display = 'grid';
}

// Listen for progress updates from the service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'progress') {
    if (msg.stage) stageText.textContent = msg.stage;
    if (typeof msg.pct === 'number') {
      progressBar.style.width = Math.max(0, Math.min(100, msg.pct)) + '%';
    }
  }
});

// Start download (keep popup open)
downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  stageText.textContent = 'Starting...';
  progressBar.style.width = '0%';
  try {
    const filename = (input.value || '').trim();
    const res = await chrome.runtime.sendMessage({ type: 'startDownload', filename });
    if (res?.ok) {
      input.value = '';
      chrome.storage.sync.set({ storedText: '' });
      progressBar.style.width = '0%';
      stageText.textContent = '';
    } else {
      stageText.textContent = 'Failed: ' + (res?.error || 'unknown error');
    }
  } catch (e) {
    console.error(e);
    stageText.textContent = 'Failed to start download.';
  } finally {
    downloadBtn.disabled = false;
  }
});
