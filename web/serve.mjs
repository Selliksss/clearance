// Usage: node web/serve.mjs [port]   (default 8787)
// Static server for Clearance Live with an SPA fallback: /agent/<id> and /run/<id> get index.html.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };
const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path === "/" || path.startsWith("/agent/") || path.startsWith("/run/")) path = "/index.html";
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const headers = {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": path.startsWith("/data/") ? "public, max-age=60" : path.startsWith("/img/") ? "public, max-age=86400" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "accept-ranges": "bytes",
    };
    // Safari plays <video> only from servers that answer byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start > end || start < 0) { res.writeHead(416, { "content-range": `bytes */${body.length}` }).end(); return; }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Clearance Live on http://127.0.0.1:${port}`));
