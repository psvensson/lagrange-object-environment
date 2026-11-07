# Authorized image read service

This host attaches to one existing image and one installed object-read binding.
It exposes Project and object reads over HTTP(S), composing the public Images
adapter. It does not install an image, create Projects, or issue authority.

A trusted operator module must export `async createDeployment()` returning:

```js
{
  service: {
    adapter,                 // createImageClientAdapter({...publicImagesApi, ...runtime})
    imageId,
    objectReadBlockId,        // preinstalled image-object-read binding
    authenticateRequest,     // request + {signal} -> authenticated identity or null
    authorityForIdentity,    // identity + {signal} -> current actual runtime context
    // tls: {key, cert},      // required to bind outside loopback
    // operationTimeoutMs: 10000, responseTimeoutMs: 2000, drainTimeoutMs: 2000, maxPending: 16
  },
  close: () => runtime.close(),
}
```

The module is deployment code, not a remote request parameter. It owns any
bootstrap work, endpoint credentials, authentication integration and grant policy.
The adapter verifies the supplied immutable read binding before listening.
Choose the Images backend explicitly. Real cluster use requires `mode: 'lagrange'`
and the public Lagrange runtime/configuration; do not use `auto` or fall back to
mock storage when a cluster is unavailable. A module whose setup fails must
release resources it acquired before returning. SIGINT/SIGTERM also impose the
shutdown ceiling during module loading or deployment startup.

```sh
node hosts/image-read-service/main.js \
  --deployment /absolute/path/to/trusted-deployment.mjs \
  --host 127.0.0.1 --port 7332 --shutdown-timeout-ms 5000
```

Bind hosts are literal IP addresses. Plaintext is restricted to `127.0.0.1` and
`::1`. For remote access, configure TLS and require the client to verify the
server certificate and refuse redirects. No default identity or credentials are
provided. The process prints only the bound address and fixed failure messages;
provider exception details are not logged.

`POST /v1/read`, content type `application/json`, accepts exactly one of:

```json
{"protocol":"environment-image-read/v1","operation":"project","imageId":"example","projectId":"integration"}
{"protocol":"environment-image-read/v1","operation":"object","imageId":"example","objectId":"root"}
```

The request image must match the attachment. Authentication is transport-local;
authority is selected server-side afresh on every request. References in results
remain locators and do not grant access. Cross-image refs are preserved in results
but this attachment cannot resolve them. No client-selected Block is accepted.

Successful responses are `{protocol, ok:true, result}`. Failures are
`{protocol, ok:false, error}` with a fixed code. The connection validates version,
status and exact envelope fields and supplies local safe error text. Requests are
limited to 16 KiB; service responses to 4 MiB. Client transports must bound bytes
before buffering; the connection additionally bounds string length before parsing.

The default operation deadline covers body, authentication, authority lookup and
read. Output delivery has a separate 2-second deadline through HTTP finish/close;
a slow reader is disconnected. A timeout/disconnect suppresses delivery; it cannot cancel an already
started Images read. Such work retains its admission slot until settlement.
`close()` fails with `ImageReadServiceDrainError` if actual work exceeds the drain
grace. The deployment must still close its runtime; the CLI attempts both cleanup
steps and exits unsuccessfully on any failure or shutdown deadline. An unref
watchdog remains until process exit so a resolving-but-leaking deployment close
cannot retain the process indefinitely.

The client composition is `createImageReadConnection({request})` followed by
`createRemoteImageClientAdapter({connection})`. `request(envelope, {signal})`
returns `{status, body}` with the body as JSON text. It owns host networking,
credential handling, TLS validation, byte limits and actual socket abort. The
connection owns protocol validation, deadline, capacity and close; no retries.
The adapter is read-only. Project refresh works; observation/follow is unavailable.

Current proof: `test/image-read-service.integration.test.js` exercises real Images
semantics over explicit mock storage. `test/image-read-service-cli.test.js` proves
process lifecycle separately. These do not establish native/live-cluster acceptance
(Bead 8dh), production SSO, native E5/E6 editing/recovery, or managed service hosting.
