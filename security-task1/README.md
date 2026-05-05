# Task 1 Security Implementation (INFO2222)

This folder is a standalone secure communication demo aligned with Task 1:

- secure password storage with salting + strong KDF
- server authentication before credentials are sent
- password transmission over TLS 1.2+
- end-to-end encrypted (E2EE) message transmission with integrity checks

## 1) What is implemented

### A. Secure password storage

- `server.js` stores **only salted password hashes**, never plaintext
- KDF: `PBKDF2-HMAC-SHA256`
- parameters:
  - random 16-byte per-user salt
  - 210,000 iterations
  - 32-byte derived key
- verification uses `timingSafeEqual` to reduce timing leakage

Why this is strong enough for the assignment:

- per-user salt prevents rainbow-table reuse
- high iteration count slows brute-force attempts
- SHA-256 inside PBKDF2 is a standard, widely reviewed primitive

### B. Server authentication on login

- The client (`client-demo.js`) uses HTTPS with:
  - CA trust (`ca.crt`)
  - hostname validation
  - optional certificate fingerprint pinning (`PINNED_SERVER_FINGERPRINT256`)
- TLS handshake and certificate verification happen **before** request payload transmission.

Hardcoded CA key implications (for discussion in your report/video):

- Pros: simple trust bootstrap in controlled environments (labs, internal demos)
- Risks:
  - key rotation is operationally hard (all clients must be updated)
  - compromise of the pinned CA/public key breaks trust at scale
  - not ideal for internet-scale PKI agility compared with managed trust stores

### C. Secure password transmission

- login and register endpoints are available only via HTTPS server
- TLS minimum version is explicitly set to `TLSv1.2`
- credentials are sent only over encrypted transport

### D. Secure message transmission (E2EE)

- each user has:
  - X25519 keypair (key agreement)
  - Ed25519 keypair (signature)
- sender encrypts message with:
  - ephemeral X25519 + recipient X25519 public key (`Diffie-Hellman`)
  - HKDF-SHA256 key derivation
  - AES-256-GCM encryption
- sender signs envelope with Ed25519 signature
- recipient verifies signature and decrypts locally
- server only stores ciphertext envelope and metadata, never plaintext

## 2) Generate demo certificates

```bash
bash security-task1/scripts/generate-dev-certs.sh
```

This creates:

- `security-task1/certs/ca.crt`
- `security-task1/certs/server.crt`
- `security-task1/certs/server.key`

## 3) Run server

```bash
node security-task1/server.js
```

Server starts at `https://localhost:8443`.

## 4) Demo commands (client)

In another terminal:

```bash
node security-task1/client-demo.js tls-info
node security-task1/client-demo.js register alice "AlicePass!2026"
node security-task1/client-demo.js register bob "BobPass!2026"
node security-task1/client-demo.js login alice "AlicePass!2026"
node security-task1/client-demo.js login bob "BobPass!2026"
node security-task1/client-demo.js send alice bob "Hi Bob, this is encrypted end-to-end."
node security-task1/client-demo.js inbox bob
```

Optional certificate pinning:

```bash
export PINNED_SERVER_FINGERPRINT256="SHA256 Fingerprint Value"
node security-task1/client-demo.js tls-info
```

## 5) Suggested 5-minute Task 1 video flow

1. show `security-task1/server.js` password KDF config and salt/hash storage
2. run register/login; open `security-task1/data/users.json` to show no plaintext password
3. show generated CA + server cert and explain trust chain
4. run `tls-info` and mention TLSv1.2+ minimum + cert check
5. send encrypted message from Alice to Bob, then:
  - show `security-task1/data/messages.json` ciphertext only
  - run Bob inbox decryption and signature verification path

## 6) AI usage appendix hint

List at least these files in your report appendix table:

- `security-task1/server.js`
- `security-task1/client-demo.js`
- `security-task1/scripts/generate-dev-certs.sh`
- `security-task1/README.md`

