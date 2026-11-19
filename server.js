
// UD V6 CoinDCX API Proxy
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function proxy(req, res, url) {
  const pathname = url.pathname.replace(/^\/api\/coindcx/, "");

  if (
    !pathname.startsWith("/exchange/") &&
    !pathname.startsWith("/market_data/")
  ) {
    return send(res, 404, "Unknown CoinDCX API route");
  }

  const host = pathname.startsWith("/exchange/")
    ? "api.coindcx.com"
    : "public.coindcx.com";

  const options = {
    hostname: host,
    path: pathname + url.search,
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "UD-V6-CoinDCX-Scanner/1.0"
    },
    timeout: 20000
  };

  const upstream = https.request(options, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, {
      "Content-Type":
        upstreamRes.headers["content-type"] || "application/json",
      "Cache-Control": "no-store"
    });
    upstreamRes.pipe(res);
  });

  upstream.on("timeout", () =>
    upstream.destroy(new Error("CoinDCX upstream timeout"))
  );

  upstream.on("error", err => {
    if (!res.headersSent) {
      send(
        res,
        502,
        JSON.stringify({
          error: "CoinDCX upstream connection failed",
          detail: err.message
        }),
        "application/json; charset=utf-8"
      );
    } else {
      res.destroy();
    }
  });

  upstream.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "GET only");
  }

  if (url.pathname === "/health") {
    return send(
      res,
      200,
      JSON.stringify({ ok: true, service: "UD V6 CoinDCX proxy" }),
      "application/json; charset=utf-8"
    );
  }

  if (url.pathname.startsWith("/api/coindcx/")) {
    return proxy(req, res, url);
  }

  const requested = url.pathname === "/"
    ? "index.html"
    : decodeURIComponent(url.pathname.slice(1));

  const filePath = path.resolve(ROOT, requested);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, "index.html")) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "File not found");

    send(
      res,
      200,
      data,
      MIME[path.extname(filePath)] || "application/octet-stream"
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UD V6 scanner running on port ${PORT}`);
});
