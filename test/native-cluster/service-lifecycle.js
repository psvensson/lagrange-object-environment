// Single owner of test service acquisition/teardown. Startup never awaits stop;
// stop waits for acquisition to settle so it cannot close an empty placeholder.
export function createServiceLifecycle({createDeployment, createService, ready}) {
  let deployment, service, startup, shutdown, stopping = false;
  return {
    start() {
      if (stopping && !startup) return Promise.resolve();
      startup ??= (async () => {
        deployment = await createDeployment();
        if (stopping) return;
        service = await createService(deployment.service);
        if (stopping) return;
        const address = await service.listen({host: '127.0.0.1', port: 0});
        if (stopping) return;
        const baseline = await deployment.snapshot();
        if (!stopping) ready({address, baseline, provenance: deployment.provenance});
      })();
      return startup;
    },
    stop() {
      stopping = true;
      shutdown ??= (async () => {
        try { await startup; } catch { /* The start caller owns the first failure. */ }
        const failures = [];
        try { await service?.close(); } catch (error) { failures.push(error); }
        try { await deployment?.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Test service cleanup failed');
      })();
      return shutdown;
    },
    snapshot() {
      if (!deployment || stopping) throw new Error('Deployment unavailable');
      return deployment.snapshot();
    },
    revoke() {
      if (!deployment || stopping) throw new Error('Deployment unavailable');
      return deployment.revoke();
    },
  };
}
