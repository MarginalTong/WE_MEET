const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const PORT = Number(process.env.SECURE_CHAT_PORT || 8443);
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const CERT_DIR = path.join(__dirname, "certs");

const TLS_OPTIONS = {
  key: fs.readFileSync(path.join(CERT_DIR, "server.key")),
  cert: fs.readFileSync(path.join(CERT_DIR, "server.crt")),
  ca: fs.readFileSync(path.join(CERT_DIR, "ca.crt")),
  minVersion: "TLSv1.2",
};

const HASH_CONFIG = {
  algorithm: "pbkdf2-sha256",
  iterations: 210000,
  keyLength: 32,
  digest: "sha256",
};

const tokenStore = new Map();

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, "[]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, saltB64) {
  return crypto
    .pbkdf2Sync(password, Buffer.from(saltB64, "base64"), HASH_CONFIG.iterations, HASH_CONFIG.keyLength, HASH_CONFIG.digest)
    .toString("base64");
}

function authenticate(req) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return null;
  const row = tokenStore.get(token);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return row.username;
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString("base64url");
  tokenStore.set(token, {
    username,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  });
  return token;
}

function routeNotFound(res) {
  json(res, 404, { error: "Not found" });
}

async function handleRegister(req, res) {
  const body = await parseJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const e2eePublicKey = String(body.e2eePublicKey || "").trim();
  const signingPublicKey = String(body.signingPublicKey || "").trim();

  if (!username || password.length < 10 || !e2eePublicKey || !signingPublicKey) {
    json(res, 400, { error: "username, strong password, and both public keys are required" });
    return;
  }

  const users = readJson(USERS_FILE);
  if (users.some((u) => u.username === username)) {
    json(res, 409, { error: "Username already exists" });
    return;
  }

  const saltB64 = crypto.randomBytes(16).toString("base64");
  const passwordHash = hashPassword(password, saltB64);
  users.push({
    username,
    password: {
      algorithm: HASH_CONFIG.algorithm,
      iterations: HASH_CONFIG.iterations,
      salt: saltB64,
      hash: passwordHash,
    },
    keys: {
      e2eePublicKey,
      signingPublicKey,
    },
    createdAt: new Date().toISOString(),
  });
  writeJson(USERS_FILE, users);
  json(res, 201, { ok: true, username });
}

async function handleLogin(req, res) {
  const body = await parseJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const users = readJson(USERS_FILE);
  const user = users.find((u) => u.username === username);
  if (!user) {
    json(res, 401, { error: "Invalid credentials" });
    return;
  }

  const computedHash = hashPassword(password, user.password.salt);
  const valid =
    computedHash.length === user.password.hash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(user.password.hash));
  if (!valid) {
    json(res, 401, { error: "Invalid credentials" });
    return;
  }

  const token = createToken(username);
  json(res, 200, { token, username });
}

function handleGetPublicKeys(req, res, urlObj) {
  const username = normalizeUsername(urlObj.searchParams.get("username"));
  if (!username) {
    json(res, 400, { error: "username is required" });
    return;
  }
  const users = readJson(USERS_FILE);
  const user = users.find((u) => u.username === username);
  if (!user) {
    json(res, 404, { error: "User not found" });
    return;
  }
  json(res, 200, {
    username: user.username,
    keys: user.keys,
  });
}

async function handleSendMessage(req, res, sender) {
  const body = await parseJsonBody(req);
  const to = normalizeUsername(body.to);
  const envelope = body.envelope;
  if (!to || !envelope || typeof envelope !== "object") {
    json(res, 400, { error: "to and envelope are required" });
    return;
  }

  const users = readJson(USERS_FILE);
  const recipient = users.find((u) => u.username === to);
  if (!recipient) {
    json(res, 404, { error: "Recipient not found" });
    return;
  }

  const messages = readJson(MESSAGES_FILE);
  const message = {
    id: crypto.randomUUID(),
    from: sender,
    to,
    envelope,
    createdAt: new Date().toISOString(),
  };
  messages.push(message);
  writeJson(MESSAGES_FILE, messages);
  json(res, 201, { ok: true, id: message.id });
}

function handleReceiveMessages(req, res, username) {
  const messages = readJson(MESSAGES_FILE).filter((m) => m.to === username);
  json(res, 200, { messages });
}

function handleTlsInfo(res, req) {
  const tlsSocket = req.socket;
  json(res, 200, {
    protocol: tlsSocket.getProtocol(),
    cipher: tlsSocket.getCipher(),
    minSupported: "TLSv1.2",
    note: "Credentials are only accepted over HTTPS with TLS1.2+",
  });
}

async function main() {
  ensureDataFiles();

  const server = https.createServer(TLS_OPTIONS, async (req, res) => {
    try {
      const urlObj = new URL(req.url, `https://${req.headers.host}`);

      if (req.method === "GET" && urlObj.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/tls-info") {
        handleTlsInfo(res, req);
        return;
      }
      if (req.method === "POST" && urlObj.pathname === "/register") {
        await handleRegister(req, res);
        return;
      }
      if (req.method === "POST" && urlObj.pathname === "/login") {
        await handleLogin(req, res);
        return;
      }
      if (req.method === "GET" && urlObj.pathname === "/public-keys") {
        handleGetPublicKeys(req, res, urlObj);
        return;
      }
      if (urlObj.pathname === "/messages") {
        const username = authenticate(req);
        if (!username) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        if (req.method === "GET") {
          handleReceiveMessages(req, res, username);
          return;
        }
        if (req.method === "POST") {
          await handleSendMessage(req, res, username);
          return;
        }
      }

      routeNotFound(res);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected error" });
    }
  });

  server.listen(PORT, () => {
    console.log(`Secure chat server listening on https://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
