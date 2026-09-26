// Container healthcheck: exit 0 if the server's /healthz answers OK.
const port = process.env.PORT || 8080;
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) })
  .then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1));
