/**
 * Task 2 demo ONLY — intentionally insecure.
 * Plain HTTP login: credentials are readable on the wire (use Wireshark on lo0).
 * Do not use real passwords. Run on localhost only.
 */
const http = require("http");

const PORT = Number(process.env.INSECURE_HTTP_PORT || 9080);

function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, warning: "This server uses HTTP only (insecure by design)." });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    const { username, password } = body;
    console.log("[insecure-transport] /login received:", { username, password });
    return json(res, 200, {
      token: "fake-session-token",
      note: "No TLS — password was sent in cleartext on the network.",
    });
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Task2 insecure TRANSPORT demo: http://127.0.0.1:${PORT}`);
  console.log("  GET  /health");
  console.log('  POST /login  body: {"username":"demo","password":"DemoPass!2026"}');
});
