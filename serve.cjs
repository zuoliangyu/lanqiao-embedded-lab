// SPDX-License-Identifier: GPL-2.0-only
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.join(__dirname, "site"),
  port = Number(process.env.PORT || 8127);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
http
  .createServer((req, res) => {
    let requested;
    try {
      requested = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(
      root,
      "." + (requested === "/" ? "/index.html" : requested),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      "Lanqiao embedded lab: http://127.0.0.1:" + port + " (Ctrl+C to stop)",
    ),
  );
