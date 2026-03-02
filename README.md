# CORS Proxy

A small Node.js server that **proxies HTTP requests** so your frontend can call APIs that don’t allow cross-origin requests (CORS). The proxy runs on your machine, fetches the URL you pass, and returns the response with CORS headers so your app (e.g. on localhost) can use it.

## What it does

- You send: `GET <proxy-base-url>?url=<encoded-target-url>`
- The server requests that target URL (same method, forwards important headers).
- It returns the target’s response (status, body, content-type) and adds CORS headers so only your allowed origins can use it from the browser.

Use it when an API blocks requests from your frontend’s origin (e.g. `http://localhost:5173`) and you control where the proxy runs.

## Usage

**Endpoint:** root path with a `url` query parameter.

```text
GET <baseurl>?url=<encoded-url>
```

- **`<baseurl>`** – where the proxy is running (e.g. `http://localhost:4000`).
- **`url`** – the **actual** URL you want the proxy to call, **URL-encoded**.

### Example from the browser

Your app runs at `http://localhost:5173` and the proxy at `http://localhost:4000`:

```js
const targetUrl = "https://api.example.com/data";
const proxyUrl = `http://localhost:4000?url=${encodeURIComponent(targetUrl)}`;

const res = await fetch(proxyUrl);
const data = await res.json();
```

### Example in the address bar or curl

```text
http://localhost:4000?url=https%3A%2F%2Fapi.example.com%2Fdata
```

```bash
curl "http://localhost:4000?url=https%3A%2F%2Fapi.example.com%2Fdata"
```

If `url` is missing or invalid, the server responds with `400` and an error message.

## Allowed origins (CORS)

Only these origins get CORS headers and can call the proxy from the browser:

- `http://localhost:3000`
- `http://localhost:5173`
- Any extra origin(s) you set in env (see below)

## Environment variables

| Variable               | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `PORT`                 | Port the proxy listens on. Default: `4000`.                                 |
| `ALLOWED_ORIGIN`       | Extra allowed origin(s), comma-separated (e.g. `http://localhost:8080`).    |
| `FETCH_TIMEOUT_MS`     | Max time (ms) to wait for the target URL. Default: `15000`.                 |
| `MAX_RESPONSE_SIZE`    | Max response body size in bytes (e.g. `5242880` = 5MB). Default: `5242880`. |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms. Default: `60000`.                                  |
| `RATE_LIMIT_MAX`       | Max requests per IP per window. Default: `60`.                              |

Copy `.env.sample` to `.env` and set as needed.

## Production-style behaviour

- **Rate limiting** – 60 requests per minute per IP (configurable).
- **SSRF protection** – Private/internal URLs (localhost, 127.x, 10.x, 192.168.x, etc.) are rejected.
- **Fetch timeout** – Outgoing request aborted after 15 seconds.
- **Max response size** – Responses larger than 5MB are rejected (configurable).
- **Protocol** – Only `http` and `https` URLs are allowed.
- **Security header** – `X-Content-Type-Options: nosniff` is set.

## Run the proxy

```bash
npm install
npm start
```

With auto-reload during development:

```bash
npm run dev
```

By default the proxy is at `http://localhost:4000`. Use that as `<baseurl>` in the usage above.
