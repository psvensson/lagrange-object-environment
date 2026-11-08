// Private process boundary delegate of the Native demo launcher. Diagnostics
// stay in the private run log; IPC exposes only bounded control outcomes.
function diagnostic(error, phase) {
  const seen = new Set();
  const records = [];
  // Eight records * three 96-unit strings stay below 16 KiB even when every
  // code unit needs a six-byte JSON escape; bound before serialization.
  function visit(value, depth) {
    if (depth > 3 || records.length >= 8 || seen.has(value)) return;
    seen.add(value);
    const text = (field) => {
      try { return String(value?.[field] ?? '').slice(0, 96); }
      catch { return 'unavailable'; }
    };
    records.push({name: text('name'), code: text('code'), message: text('message')});
    try {
      if (Array.isArray(value?.errors)) {
        for (let i = 0; i < Math.min(value.errors.length, 8); i++) visit(value.errors[i], depth + 1);
      }
      if (value?.cause !== undefined) visit(value.cause, depth + 1);
    } catch { /* Diagnostic access must not interfere with shutdown. */ }
  }
  visit(error, 0);
  return JSON.stringify({event: 'demo-worker-failure', phase, errors: records}) + '\n';
}

export function serveDemoWorker({initialize, endpoint = process, shutdownMs = 10_000,
  writeDiagnostic = (text) => endpoint.stderr.write(text)}) {
  let lifecycle, initialization, shutdown;
  let stopping = false, lastId = 0;
  const reported = new Set();
  const report = (error, phase) => {
    endpoint.exitCode = 1;
    if (reported.has(phase)) return;
    reported.add(phase);
    try { writeDiagnostic(diagnostic(error, phase)); } catch { /* Retain failure status. */ }
  };
  function fail(error, phase = 'protocol') { report(error, phase); void stop(); }
  function send(message) {
    if (stopping) return;
    if (!endpoint.connected) { fail(new Error('Demo IPC disconnected')); return; }
    try { endpoint.send(message, (error) => { if (error) fail(error); }); }
    catch (error) { fail(error); }
  }
  function stop() {
    stopping = true;
    shutdown ??= (async () => {
      const ceiling = setTimeout(() => endpoint.exit(1), shutdownMs);
      try {
        try { await initialization; } catch { /* Initialization caller reports it. */ }
        try { await lifecycle?.stop(); } catch (error) { report(error, 'cleanup'); }
      } finally {
        if (endpoint.connected) {
          try { endpoint.disconnect(); } catch (error) { report(error, 'cleanup'); }
        }
        // Clean children can exit; leaked handles retain the independent ceiling.
        ceiling.unref();
      }
    })();
    return shutdown;
  }
  endpoint.once('SIGTERM', () => void stop());
  endpoint.once('SIGINT', () => void stop());
  endpoint.once('disconnect', () => void stop());
  endpoint.on('error', fail);
  endpoint.on('message', (message) => {
    const valid = message && Object.keys(message).length === 2 &&
      Number.isSafeInteger(message.id) && message.id > lastId &&
      ['start', 'members', 'install'].includes(message.command);
    if (!valid || !lifecycle || stopping) { fail(new Error('Invalid demo command')); return; }
    lastId = message.id;
    void lifecycle.run(message.command).then(
      (value) => send({id: message.id, ok: true, value}),
      (error) => { send({id: message.id, ok: false}); fail(error, 'operation'); });
  });
  // Install signal/error handlers before acquisition and retain late results.
  initialization = (async () => {
    if (!endpoint.connected || stopping) return;
    lifecycle = await initialize();
    if (!stopping) send({event: 'worker-ready'});
  })();
  void initialization.catch((error) => fail(error, 'initialization'));
  if (!endpoint.connected) void stop();
  return {stop};
}
