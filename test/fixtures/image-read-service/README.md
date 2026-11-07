# Public TLS test fixture

This self-signed localhost certificate and its intentionally public private key
exist only for HTTPS contract tests. Never use them in a deployment. Clients in
the tests explicitly trust this certificate; certificate verification is enabled.
