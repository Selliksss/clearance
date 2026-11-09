// Usage: node web/serve.mjs [port]   (default 8787)
// Static server for Clearance Live with an SPA fallback: /test, /agent/<id> and /run/<id> get index.html.
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };
const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
// Local development only: API_PROXY=http://127.0.0.1:8788 forwards /api/ to the bot's web API. In production Caddy does it.
const API_PROXY = process.env.API_PROXY ? new URL(process.env.API_PROXY) : null;

function proxy(req, res) {
  const up = request({ host: API_PROXY.hostname, port: API_PROXY.port, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}

// Arrivals per day: which page a visitor landed on and the referring site, nothing else (no IPs, no paths of the
// referrer, no cookies). In-site navigation happens in the browser and is not counted. Written to VISITS_DIR.
const VISITS_DIR = process.env.VISITS_DIR ?? join(homedir(), ".config", "dopusk", "visits");
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
let visits = { day: "", pages: {}, from: {} };
function countVisit(req, path) {
  if (BOT.test(req.headers["user-agent"] ?? "")) return;
  const day = new Date().toISOString().slice(0, 10);
  if (visits.day !== day) {
    flushVisits();
    try { visits = JSON.parse(readFileSync(join(VISITS_DIR, `${day}.json`), "utf8")); } catch { visits = { day, pages: {}, from: {} }; }
  }
  const page = path.replace(/^\/(test|challenge|agent|run)\/.+/, "/$1/:id");
  visits.pages[page] = (visits.pages[page] ?? 0) + 1;
  let from = "direct";
  try { if (req.headers.referer) from = new URL(req.headers.referer).hostname; } catch {}
  if (from === "agentcrashtest.com") from = "self";
  visits.from[from] = (visits.from[from] ?? 0) + 1;
}
function flushVisits() {
  if (!visits.day) return;
  try { mkdirSync(VISITS_DIR, { recursive: true }); writeFileSync(join(VISITS_DIR, `${visits.day}.json`), JSON.stringify(visits)); } catch {}
}
setInterval(flushVisits, 60_000).unref();
process.on("SIGTERM", () => { flushVisits(); process.exit(0); });

async function handle(req, res) {
  let path;
  // A malformed escape (%E0) or a protocol-relative target (//) must answer 400, not take the process down.
  try { path = normalize(decodeURIComponent(new URL("http://x" + (req.url ?? "/")).pathname)).replace(/^(\.\.[/\\])+/, ""); }
  catch { res.writeHead(400).end(); return; }
  if (API_PROXY && path.startsWith("/api/")) return proxy(req, res);
  if (path === "/" || path === "/findings" || path === "/mcp" || path === "/test" || path.startsWith("/test/") || path === "/challenge" || path.startsWith("/challenge/") || path.startsWith("/agent/") || path.startsWith("/run/")) {
    if (req.method === "GET") countVisit(req, path);
    path = "/index.html";
  }
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
  const headers = {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": path.startsWith("/data/") ? "public, max-age=60" : path.startsWith("/img/") ? "public, max-age=86400" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "accept-ranges": "bytes",
  };
  // Safari plays <video> only from servers that answer byte ranges with a sized 206.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${body.length}` }).end(); return; }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
    res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { ...headers, "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

createServer((req, res) => {
  handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
}).listen(port, "127.0.0.1", () => console.log(`Clearance Live on http://127.0.0.1:${port}`));
