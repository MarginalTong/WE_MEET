#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT_DIR/certs"
mkdir -p "$CERT_DIR"

echo "Generating CA key/cert..."
openssl genrsa -out "$CERT_DIR/ca.key" 4096
openssl req -x509 -new -nodes -key "$CERT_DIR/ca.key" -sha256 -days 3650 \
  -out "$CERT_DIR/ca.crt" -subj "/C=AU/ST=NSW/L=Sydney/O=USYD/OU=INFO2222/CN=Task1 Demo CA"

echo "Generating server key/CSR..."
openssl genrsa -out "$CERT_DIR/server.key" 2048
openssl req -new -key "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
  -subj "/C=AU/ST=NSW/L=Sydney/O=USYD/OU=INFO2222/CN=localhost"

cat > "$CERT_DIR/server.ext" <<'EOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

echo "Signing server certificate with CA..."
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -out "$CERT_DIR/server.crt" -days 825 -sha256 -extfile "$CERT_DIR/server.ext"

echo
echo "Done. Server certificate fingerprint (SHA256):"
openssl x509 -in "$CERT_DIR/server.crt" -noout -fingerprint -sha256

