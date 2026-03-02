import 'dotenv/config';
import dns from 'dns';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT ?? 4000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 15_000;
const MAX_RESPONSE_SIZE = Number(process.env.MAX_RESPONSE_SIZE) || 5 * 1024 * 1024; // 5MB
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000; // 1 min
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60; // 60 req per window

const dnsLookup = dns.promises.lookup.bind(dns.promises);

/** True if the IP is private/local (SSRF risk). */
function isPrivateIP(ip) {
  if (ip === '::1' || ip === 'localhost') return true;
  // IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    const [a, b, c] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6: link-local, unique local
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

/** Reject if hostname resolves to a private IP (SSRF protection). */
async function ensurePublicUrl(url) {
  const hostname = url.hostname;
  if (!hostname) throw new Error('Invalid hostname');
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    throw new Error('Private URLs are not allowed');
  }
  try {
    const { address } = await dnsLookup(hostname, { family: 0 });
    if (isPrivateIP(address)) {
      throw new Error('Private URLs are not allowed');
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') throw new Error('Host not found');
    throw err;
  }
}

/** Read response body up to maxBytes; throw if exceeded. */
async function readWithLimit(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > maxBytes) {
      throw new Error(`Response too large (max ${maxBytes} bytes)`);
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large (max ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const length = chunks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

// Build allowed origins: localhost:3000, localhost:5173, plus env (comma-separated)
const envOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : [];
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  ...envOrigins,
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', deployed: true });
});

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use(limiter);

app.get('/', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query: url' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }

  try {
    await ensurePublicUrl(targetUrl);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': req.headers['user-agent'] ?? 'CORS-Proxy/1.0',
        ...(req.headers['accept'] && { Accept: req.headers['accept'] }),
      },
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    if (!response.ok) {
      res.status(response.status);
      const text = await response.text();
      return res.send(text);
    }

    const buffer = await readWithLimit(response, MAX_RESPONSE_SIZE);
    res.send(Buffer.from(buffer));
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timeout' });
    }
    if (err.message?.includes('too large')) {
      return res.status(413).json({ error: err.message });
    }
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch URL', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CORS proxy running at http://localhost:${PORT}`);
  console.log('Usage: GET ?url=<encoded-url>');
  console.log('Allowed origins:', allowedOrigins.join(', '));
  console.log(`Limits: ${RATE_LIMIT_MAX} req/${RATE_LIMIT_WINDOW_MS / 1000}s, ${FETCH_TIMEOUT_MS / 1000}s timeout, ${MAX_RESPONSE_SIZE / 1024 / 1024}MB max response`);
});
