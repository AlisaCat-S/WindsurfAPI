import https from 'node:https';
import http from 'node:http';
import { log } from './config.js';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function parseDataUrl(url) {
  const m = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  return { base64_data: m[2], mime_type: m[1].toLowerCase() };
}

export function fetchImageUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'Accept': 'image/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageUrl(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Image fetch HTTP ${res.statusCode}`));
      }
      const mime = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!MIME_OK.has(mime)) {
        res.resume();
        return reject(new Error(`Unsupported image type: ${mime}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_SIZE) { res.destroy(); reject(new Error(`Image exceeds ${MAX_SIZE} bytes`)); }
        else chunks.push(d);
      });
      res.on('end', () => resolve({ base64_data: Buffer.concat(chunks).toString('base64'), mime_type: mime }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image fetch timeout')); });
  });
}

export async function extractImages(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return { text: String(contentBlocks ?? ''), images: [] };

  let text = '';
  const images = [];

  for (const block of contentBlocks) {
    if (!block || typeof block === 'string') { text += block || ''; continue; }

    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'image') {
      // Anthropic format: {type:"image", source:{type:"base64"|"url", media_type, data|url}}
      const src = block.source || {};
      try {
        if (src.type === 'base64' && src.data) {
          images.push({ base64_data: src.data, mime_type: src.media_type || 'image/png' });
        } else if (src.type === 'url' && src.url) {
          images.push(await fetchImageUrl(src.url));
        } else if (src.data) {
          images.push({ base64_data: src.data, mime_type: src.media_type || 'image/png' });
        }
      } catch (e) { log.warn(`Image extraction failed: ${e.message}`); }
    } else if (block.type === 'image_url') {
      // OpenAI format: {type:"image_url", image_url:{url:"data:..." | "https://..."}}
      const url = block.image_url?.url || '';
      try {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed);
        } else if (url.startsWith('http')) {
          images.push(await fetchImageUrl(url));
        }
      } catch (e) { log.warn(`Image fetch failed: ${e.message}`); }
    }
  }

  return { text, images };
}
