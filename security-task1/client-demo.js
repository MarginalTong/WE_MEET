const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const BASE_URL = process.env.SECURE_CHAT_URL || "https://localhost:8443";
const CERT_DIR = path.join(__dirname, "certs");
const CLIENT_DIR = path.join(__dirname, "client-state");
const CA_CERT = fs.readFileSync(path.join(CERT_DIR, "ca.crt"), "utf8");

const PINNED_SERVER_FINGERPRINT256 = (process.env.PINNED_SERVER_FINGERPRINT256 || "").trim();

function ensureClientDir() {
  fs.mkdirSync(CLIENT_DIR, { recursive: true });
}

function statePath(username) {
  return path.join(CLIENT_DIR, `${username}.json`);
}

function normalizeUsername(v) {
  return String(v || "").trim().toLowerCase();
}

function httpsJson(method, endpoint, payload, token) {
  const url = new URL(endpoint, BASE_URL);
  const body = payload == null ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ca: CA_CERT,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        checkServerIdentity: (host, cert) => {
          const defaultErr = tlsCheck(host, cert);
          if (defaultErr) return defaultErr;
          if (PINNED_SERVER_FINGERPRINT256 && cert.fingerprint256 !== PINNED_SERVER_FINGERPRINT256) {
            return new Error(`Pinned fingerprint mismatch for ${host}`);
          }
          return undefined;
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => {
          chunks += d;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = chunks ? JSON.parse(chunks) : {};
          } catch {
            reject(new Error(`Invalid JSON response: ${chunks}`));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function tlsCheck(host, cert) {
  return require("tls").checkServerIdentity(host, cert);
}

function getOrCreateIdentity(username) {
  ensureClientDir();
  const file = statePath(username);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  const e2ee = crypto.generateKeyPairSync("x25519");
  const signing = crypto.generateKeyPairSync("ed25519");
  const identity = {
    username,
    e2eePrivateKeyPem: e2ee.privateKey.export({ type: "pkcs8", format: "pem" }),
    e2eePublicKeyPem: e2ee.publicKey.export({ type: "spki", format: "pem" }),
    signingPrivateKeyPem: signing.privateKey.export({ type: "pkcs8", format: "pem" }),
    signingPublicKeyPem: signing.publicKey.export({ type: "spki", format: "pem" }),
    token: "",
  };
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

function saveIdentity(identity) {
  fs.writeFileSync(statePath(identity.username), `${JSON.stringify(identity, null, 2)}\n`);
}

function deriveMessageKey(sharedSecret, salt) {
  return crypto.hkdfSync("sha256", sharedSecret, salt, Buffer.from("we-meet-task1-e2ee"), 32);
}

function encryptForRecipient(senderIdentity, recipientE2eePublicKeyPem, plainText) {
  const eph = crypto.generateKeyPairSync("x25519");
  const sharedSecret = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: crypto.createPublicKey(recipientE2eePublicKeyPem),
  });
  const salt = crypto.randomBytes(16);
  const key = deriveMessageKey(sharedSecret, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(Buffer.from(plainText, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelopeToSign = {
    e2eeVersion: "x25519-hkdf-aes-256-gcm-v1",
    ephPublicKeyPem: eph.publicKey.export({ type: "spki", format: "pem" }),
    saltB64: salt.toString("base64"),
    ivB64: iv.toString("base64"),
    cipherTextB64: cipherText.toString("base64"),
    authTagB64: tag.toString("base64"),
  };
  const signPayload = Buffer.from(JSON.stringify(envelopeToSign), "utf8");
  const signature = crypto.sign(null, signPayload, crypto.createPrivateKey(senderIdentity.signingPrivateKeyPem));
  return {
    ...envelopeToSign,
    signatureB64: signature.toString("base64"),
    senderSigningPublicKeyPem: senderIdentity.signingPublicKeyPem,
  };
}

function decryptFromSender(recipientIdentity, envelope) {
  const signedEnvelope = {
    e2eeVersion: envelope.e2eeVersion,
    ephPublicKeyPem: envelope.ephPublicKeyPem,
    saltB64: envelope.saltB64,
    ivB64: envelope.ivB64,
    cipherTextB64: envelope.cipherTextB64,
    authTagB64: envelope.authTagB64,
  };
  const validSig = crypto.verify(
    null,
    Buffer.from(JSON.stringify(signedEnvelope), "utf8"),
    crypto.createPublicKey(envelope.senderSigningPublicKeyPem),
    Buffer.from(envelope.signatureB64, "base64")
  );
  if (!validSig) throw new Error("Message signature verification failed");

  const sharedSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(recipientIdentity.e2eePrivateKeyPem),
    publicKey: crypto.createPublicKey(envelope.ephPublicKeyPem),
  });
  const key = deriveMessageKey(sharedSecret, Buffer.from(envelope.saltB64, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTagB64, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.cipherTextB64, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

async function register(username, password) {
  const u = normalizeUsername(username);
  const identity = getOrCreateIdentity(u);
  await httpsJson("POST", "/register", {
    username: u,
    password,
    e2eePublicKey: identity.e2eePublicKeyPem,
    signingPublicKey: identity.signingPublicKeyPem,
  });
  console.log(`Registered: ${u}`);
}

async function login(username, password) {
  const u = normalizeUsername(username);
  const identity = getOrCreateIdentity(u);
  const result = await httpsJson("POST", "/login", { username: u, password });
  identity.token = result.token;
  saveIdentity(identity);
  console.log(`Logged in: ${u}`);
}

async function send(fromUser, toUser, plainText) {
  const from = normalizeUsername(fromUser);
  const to = normalizeUsername(toUser);
  const identity = getOrCreateIdentity(from);
  if (!identity.token) throw new Error(`User ${from} is not logged in`);

  const recipient = await httpsJson("GET", `/public-keys?username=${encodeURIComponent(to)}`);
  const envelope = encryptForRecipient(identity, recipient.keys.e2eePublicKey, plainText);

  await httpsJson(
    "POST",
    "/messages",
    {
      to,
      envelope,
    },
    identity.token
  );
  console.log(`Encrypted message sent from ${from} to ${to}`);
}

async function inbox(username) {
  const u = normalizeUsername(username);
  const identity = getOrCreateIdentity(u);
  if (!identity.token) throw new Error(`User ${u} is not logged in`);

  const result = await httpsJson("GET", "/messages", null, identity.token);
  if (!result.messages.length) {
    console.log("No messages");
    return;
  }
  result.messages.forEach((m) => {
    const text = decryptFromSender(identity, m.envelope);
    console.log(`[${m.createdAt}] ${m.from} -> ${m.to}: ${text}`);
  });
}

async function tlsInfo() {
  const info = await httpsJson("GET", "/tls-info");
  console.log(info);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(
      [
        "Usage:",
        "  node security-task1/client-demo.js tls-info",
        "  node security-task1/client-demo.js register <username> <password>",
        "  node security-task1/client-demo.js login <username> <password>",
        "  node security-task1/client-demo.js send <fromUser> <toUser> <message>",
        "  node security-task1/client-demo.js inbox <username>",
      ].join("\n")
    );
    return;
  }

  if (cmd === "tls-info") {
    await tlsInfo();
    return;
  }
  if (cmd === "register") {
    const [username, password] = rest;
    await register(username, password);
    return;
  }
  if (cmd === "login") {
    const [username, password] = rest;
    await login(username, password);
    return;
  }
  if (cmd === "send") {
    const [from, to, ...msgParts] = rest;
    await send(from, to, msgParts.join(" "));
    return;
  }
  if (cmd === "inbox") {
    const [username] = rest;
    await inbox(username);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});