#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets");
const cli = process.argv.slice(2);
const dataDir = path.resolve(cli.includes("--data-dir") ? cli[cli.indexOf("--data-dir") + 1] : path.join(root, "data"));
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8877);
const sessionPort = Number(process.argv.includes("--session-port") ? process.argv[process.argv.indexOf("--session-port") + 1] : 8879);
const sessionKey = await fs.readFile(path.join(dataDir, "sessiond.key"));

function json(response, status, value) { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }); response.end(body); }
function internalPath(pathname) { return `/internal${pathname.slice("/api".length)}`; }

const server = http.createServer(async (request, response) => {
  if (request.headers.host?.toLowerCase() !== `127.0.0.1:${server.address()?.port || port}`) return json(response, 421, { error: "loopback host required" });
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/health") return json(response, 200, { ok: true, mode: "node-bridge-api", sessiond: `http://127.0.0.1:${sessionPort}` });
    const staticNames = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/job-stream.js": "job-stream.js", "/app.css": "app.css", "/tus.min.js": path.join("..", "node", "node_modules", "tus-js-client", "dist", "tus.min.js") };
    if (request.method === "GET" && staticNames[url.pathname]) {
      const content = await fs.readFile(path.resolve(assets, staticNames[url.pathname]));
      response.writeHead(200, { "content-type": staticNames[url.pathname].endsWith(".css") ? "text/css; charset=utf-8" : staticNames[url.pathname].endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", "content-length": content.length, "cache-control": "no-store" });
      return response.end(content);
    }
    if (url.pathname.startsWith("/api/v1/sessions") || url.pathname.startsWith("/api/v1/agent") || url.pathname.startsWith("/api/v1/transfers") || url.pathname === "/api/v1/host-keys/trust") {
      const hasBody = !["GET", "HEAD"].includes(request.method) && (Number(request.headers["content-length"] || 0) > 0 || Boolean(request.headers["transfer-encoding"]));
      const forwardedHeaders = { "x-session-key": sessionKey.toString("hex") };
      for (const name of ["content-type", "content-length", "tus-resumable", "upload-length", "upload-offset", "upload-metadata", "upload-defer-length", "upload-concat", "x-rcb-session"]) if (request.headers[name]) forwardedHeaders[name] = request.headers[name];
      const upstream = await fetch(`http://127.0.0.1:${sessionPort}${internalPath(url.pathname)}${url.search}`, { method: request.method, headers: forwardedHeaders, body: hasBody ? request : undefined, duplex: "half" });
      const responseHeaders = { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": upstream.headers.get("content-type")?.startsWith("text/event-stream") ? "no-cache, no-store" : "no-store", "x-content-type-options": "nosniff" };
      for (const name of ["content-length", "content-disposition", "location", "tus-resumable", "tus-version", "tus-extension", "tus-max-size", "upload-offset", "upload-length", "upload-metadata", "upload-expires"]) { const value = upstream.headers.get(name); if (value) responseHeaders[name] = value.replace?.(`http://127.0.0.1:${sessionPort}/internal/v1/transfers`, "/api/v1/transfers") || value; }
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(chunk);
      }
      return response.end();
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 502, { error: error.message || "bridge-api error" });
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ ok: true, mode: "node-bridge-api", url: `http://127.0.0.1:${server.address().port}` })}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0))); process.on("SIGINT", () => server.close(() => process.exit(0)));
