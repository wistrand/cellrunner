// Minimal static file server for CELLRUNNER local development. ES modules can't be loaded from file://
// in most browsers (CORS), so `npm start` runs this on http://localhost:8002/ instead.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8002;
// Anchor the served root to ../docs relative to this script file, so the server works whether you
// run it from the repo root, from scripts/, or via `npm start`.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../docs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
};

createServer(async (req, res) => {
  try {
    let url = req.url.split("?")[0];
    if (url === "/" || url === "") url = "/index.html";
    const path = join(ROOT, url);
    // Defend against directory traversal.
    if (!path.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await readFile(path);
    const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500);
    res.end(err.code === "ENOENT" ? "Not found" : "Server error");
  }
}).listen(PORT, () => {
  console.log(`CELLRUNNER dev server: http://localhost:${PORT}/`);
});
