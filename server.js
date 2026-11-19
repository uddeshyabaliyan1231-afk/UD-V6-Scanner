
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
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function upstreamRequest(host, apiPath, res) {
  const req = https.request({
    hostname: host,
    path: apiPath,
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "UD-V6-CoinDCX-Scanner/2.0"
    },
    timeout: 20000
  }, response => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", chunk => body += chunk);
    response.on("end", () => {
      send(
        res,
        response.statusCode || 502,
        body,
        response.headers["content-type"] || "application/json"
      );
    });
  });

  req.on("timeout", () => req.destroy(new Error("Upstream timeout")));
  req.on("error", err => {
    send(res, 502, JSON.stringify({
      error: "CoinDCX connection failed",
      detail: err.message
    }), "application/json");
  });

  req.end();
}

function handleKlines(url, res) {
  const pairPath = url.pathname.split("/").pop();
  const pair = pairPath.replace(/-futures$/, "");

  if (!/^B-[A-Z0-9]+_USDT$/.test(pair)) {
    return send(res, 400, JSON.stringify({
      error: "Invalid futures pair",
      pair
    }), "application/json");
  }

  const interval = url.searchParams.get("interval") || "5m";
  if (!["5m", "15m"].includes(interval)) {
    return send(res, 400, JSON.stringify({
      error: "Unsupported interval",
      interval
    }), "application/json");
  }

  const now = Math.floor(Date.now() / 1000);

  let from = Number(url.searchParams.get("startTime"));
  let to = Number(url.searchParams.get("endTime"));

  if (!Number.isFinite(from) || from <= 0) {
    from = now - 140 * (interval === "15m" ? 900 : 300);
  }
  if (!Number.isFinite(to) || to <= 0) to = now;

  // CoinDCX REST candle API expects seconds.
  if (from > 1e12) from = Math.floor(from / 1000);
  if (to > 1e12) to = Math.floor(to / 1000);

  // Fetch enough 5-minute candles for either timeframe.
  if (interval === "15m") {
    from = Math.min(from, to - 140 * 900);
  } else {
    from = Math.min(from, to - 140 * 300);
  }

  const apiPath =
    "/market_data/candlesticks" +
    "?pair=" + encodeURIComponent(pair) +
    "&from=" + Math.floor(from) +
    "&to=" + Math.floor(to) +
    "&resolution=5&pcode=f";

  const req = https.request({
    hostname: "public.coindcx.com",
    path: apiPath,
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "UD-V6-CoinDCX-Scanner/2.0"
    },
    timeout: 20000
  }, upstream => {
    let body = "";
    upstream.setEncoding("utf8");
    upstream.on("data", chunk => body += chunk);

    upstream.on("end", () => {
      if (upstream.statusCode !== 200) {
        return send(res, upstream.statusCode || 502, body,
          "application/json");
      }

      try {
        const parsed = JSON.parse(body);
        const raw = Array.isArray(parsed) ? parsed : (parsed.data || []);

        let candles = raw.map(c => ({
          time: Number(c.time || c.open_time || 0),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0)
        })).filter(c =>
          c.time &&
          [c.open, c.high, c.low, c.close].every(Number.isFinite)
        ).sort((a, b) => a.time - b.time);

        if (interval === "15m") {
          const groups = new Map();

          for (const c of candles) {
            const seconds = c.time > 1e12
              ? Math.floor(c.time / 1000)
              : c.time;

            const key = Math.floor(seconds / 900) * 900;
            let g = groups.get(key);

            if (!g) {
              g = {
                time: key * 1000,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: 0
              };
              groups.set(key, g);
            }

            g.high = Math.max(g.high, c.high);
            g.low = Math.min(g.low, c.low);
            g.close = c.close;
            g.volume += c.volume;
          }

          candles = Array.from(groups.values());
        }

        send(res, 200, JSON.stringify({
          s: "ok",
          data: candles
        }), "application/json");

      } catch (err) {
        send(res, 502, JSON.stringify({
          error: "Invalid CoinDCX candle response",
          detail: err.message
        }), "application/json");
      }
    });
  });

  req.on("timeout", () => req.destroy(new Error("Candle request timeout")));
  req.on("error", err => {
    send(res, 502, JSON.stringify({
      error: "Candle API connection failed",
      detail: err.message
    }), "application/json");
  });

  req.end();
}

function proxy(req, res, url) {
  const pathname = url.pathname.replace(/^\/api\/coindcx/, "");

  // Convert the scanner's old K-line URL to CoinDCX's official candle API.
  if (pathname.startsWith("/market_data/v3/klines/")) {
    return handleKlines(url, res);
  }

  if (
    !pathname.startsWith("/exchange/") &&
    !pathname.startsWith("/market_data/")
  ) {
    return send(res, 404, "Unknown CoinDCX API route");
  }

  const host = pathname.startsWith("/exchange/")
    ? "api.coindcx.com"
    : "public.coindcx.com";

  upstreamRequest(host, pathname + url.search, res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "GET only");
  }

  if (url.pathname === "/health") {
    return send(res, 200, JSON.stringify({
      ok: true,
      service: "UD V6 CoinDCX proxy",
      candleFix: "enabled"
    }), "application/json");
  }

  if (url.pathname.startsWith("/api/coindcx/")) {
    return proxy(req, res, url);
  }

  const filePath = url.pathname === "/"
    ? path.join(ROOT, "index.html")
    : path.join(ROOT, path.normalize(url.pathname)
        .replace(/^(\.\.(\/|\\|$))+/, ""));

  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "File not found");
    send(res, 200, data,
      MIME[path.extname(filePath)] || "application/octet-stream");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("UD V6 CoinDCX proxy running on port " + PORT);
});
