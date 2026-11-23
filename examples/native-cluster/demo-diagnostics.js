// Bounded private failure records have their own FD; ordinary stderr is opaque.
import {openSync, writeSync, closeSync} from 'node:fs';

const PHASES = ['initialization', 'operation', 'protocol', 'cleanup'];
const LIMIT = 16384;

export function writeDemoDiagnostic(text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(4, bytes, offset);
}

export function openDemoDiagnostics(path, onFailure, onRecord = () => {}) {
  const fd = openSync(path, 'wx', 0o600);
  const phases = new Set();
  let pending = Buffer.alloc(0), closed = false, invalid = false;
  function reject() {
    if (invalid) return;
    invalid = true; pending = Buffer.alloc(0);
    onFailure(new Error('Invalid private demo diagnostic'));
  }
  function record(bytes) {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { reject(); return; }
    if (!value || Object.keys(value).length !== 3 || value.event !== 'demo-worker-failure' ||
      !PHASES.includes(value.phase) || !Array.isArray(value.errors) ||
      value.errors.length < 1 || value.errors.length > 8 || value.errors.some((error) =>
        !error || Object.keys(error).length !== 3 || ['name', 'code', 'message'].some((key) =>
          typeof error[key] !== 'string' || error[key].length > 96))) { reject(); return; }
    if (phases.has(value.phase)) return;
    phases.add(value.phase);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      writeSync(fd, '\n'); onRecord(value);
    } catch (error) { onFailure(error); }
  }
  return {
    write(chunk) {
      if (invalid || closed) return;
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        if (pending.length + part.length >= LIMIT) { reject(); return; }
        pending = Buffer.concat([pending, part]);
        if (end < 0) return;
        record(pending); pending = Buffer.alloc(0);
        if (invalid) return;
        start = end + 1;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (pending.length) reject();
      try { closeSync(fd); } catch (error) { onFailure(error); }
    },
  };
}
