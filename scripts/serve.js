// Minimal static file server for CELLRUNNER local development. ES modules can't be loaded from file://
// in most browsers (CORS), so `npm start` runs this on http://localhost:8002/ instead.

import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8002;
// Anchor the served root to ../docs relative to this script file, so the server works whether you
// run it from the repo root, from scripts/, or via `npm start`.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../docs");
// Inside the root means the root itself or a path below it. A plain prefix test is not enough:
// "../docs-other/x" starts with the root's text and is still outside.
const inside = (p) => p === ROOT || p.startsWith(ROOT + sep);

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
    // Decode first, so "%2e%2e" is seen as ".." by the checks below; reject what cannot be a
    // file name.
    let url;
    try {
      url = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    if (url.includes("\0")) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    if (url === "/" || url === "") url = "/index.html";
    // Traversal: join normalises "..", then the result must lie inside the root, and so must the
    // real path after following any symlink.
    const path = join(ROOT, url);
    if (!inside(path)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const real = await realpath(path);
    if (!inside(real)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await readFile(real);
    const type = TYPES[extname(real).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch (err) {
    // A missing file or a directory is a 404 (no directory listings); anything else is ours.
    const missing = err.code === "ENOENT" || err.code === "EISDIR" || err.code === "ENOTDIR";
    res.writeHead(missing ? 404 : 500);
    res.end(missing ? "Not found" : "Server error");
  }
}).listen(PORT, () => {
  console.log(`CELLRUNNER dev server: http://localhost:${PORT}/`);
});
