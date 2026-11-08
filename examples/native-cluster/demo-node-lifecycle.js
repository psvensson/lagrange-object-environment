// Owns one demo worker's acquisitions and teardown sequencing. Runtime/image
// semantics remain with the public providers; no command is retried here.
function cleanupRuntimePort(runtime, record) {
  return Object.freeze({
    start(...args) { return Reflect.apply(runtime.start, runtime, args); },
    openApplicationDatabase(...args) {
      return Reflect.apply(runtime.openApplicationDatabase, runtime, args);
    },
    stop(...args) {
      let result;
      try { result = Reflect.apply(runtime.stop, runtime, args); }
      catch (error) { record(error); throw error; }
      // Observe without replacing the provider's promise or its rejection.
      Promise.resolve(result).then(undefined, record).catch(() => {});
      return result;
    },
  });
}

export function createDemoNodeLifecycle({configuration, role, createRuntime,
  createDeployment, createService}) {
  let runtime, deployment, service, operation, shutdown;
  let state = 'created', stopping = false;
  const failures = [];
  const recordCleanupFailure = (error) => { if (!failures.includes(error)) failures.push(error); };

  const requireState = (expected) => {
    if (state !== expected) throw new Error(`Demo node is ${state}; expected ${expected}`);
  };
  async function perform(command) {
    if (command === 'start') {
      requireState('created');
      state = 'starting';
      runtime = createRuntime({configuration});
      await runtime.start();
      if (stopping) throw new Error('Demo node stopping');
      state = 'started';
      return {started: true};
    }
    if (command === 'members') {
      requireState('started');
      const database = runtime.openApplicationDatabase({applicationId: 'oe-native-demo-operator'});
      const result = await database.query('SELECT node_id, status FROM nodes');
      if (!Array.isArray(result.rows) || result.rows.length > 64) throw new Error('Invalid membership result');
      return result.rows.map((row) => {
        if (typeof row.node_id !== 'string' || row.node_id.length > 128 ||
          typeof row.status !== 'string' || row.status.length > 32) throw new Error('Invalid member');
        return {nodeId: row.node_id, status: row.status};
      });
    }
    if (command === 'install') {
      requireState('started');
      if (role !== 'seed') throw new Error('Only the seed installs the demo');
      state = 'installing';
      // Retain the raw handle even if a provider rejects before returning.
      // The pinned Images backend starts/stops this handle idempotently.
      deployment = await createDeployment(cleanupRuntimePort(runtime, recordCleanupFailure), recordCleanupFailure);
      if (stopping) throw new Error('Demo node stopping');
      service = await createService(deployment.service);
      if (stopping) throw new Error('Demo node stopping');
      const address = await service.listen({host: '127.0.0.1', port: 0});
      if (stopping) throw new Error('Demo node stopping');
      state = 'serving';
      return address;
    }
    throw new Error('Unknown demo node command');
  }

  return {
    run(command) {
      if (stopping) return Promise.reject(new Error('Demo node stopping'));
      if (operation) return Promise.reject(new Error('Demo node operation already pending'));
      operation = perform(command).finally(() => { operation = null; });
      return operation;
    },
    stop() {
      stopping = true;
      shutdown ??= (async () => {
        try { await operation; } catch { /* The operation caller retains its first failure. */ }
        try { await service?.close(); } catch (error) { recordCleanupFailure(error); }
        try { await deployment?.close(); } catch (error) { recordCleanupFailure(error); }
        // A createRuntime/graph failure may have acquired nothing returnable.
        // A prior cleanup failure stays a failure even if this stop is a no-op.
        try { await runtime?.stop(); } catch (error) { recordCleanupFailure(error); }
        state = 'stopped';
        if (failures.length) throw new AggregateError(failures, 'Demo node cleanup incomplete');
      })();
      return shutdown;
    },
  };
}
