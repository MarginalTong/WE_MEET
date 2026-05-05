Put TLS certificates in this directory.

For local demo:

1. Run `bash security-task1/scripts/generate-dev-certs.sh`
2. Confirm files exist:
   - `security-task1/certs/ca.crt`
   - `security-task1/certs/server.crt`
   - `security-task1/certs/server.key`

Never commit private keys (`*.key`) to a public repository.
