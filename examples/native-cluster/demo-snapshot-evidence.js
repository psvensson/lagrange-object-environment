// Private bounded transfer only. The deployment remains the snapshot authority.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute, join} from 'node:path';

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 16000; // Leave room for the unchanged 16384-byte IPC envelope.

export function snapshotEvidencePath(directory, sequence) {
  if (!isAbsolute(directory) || ![1, 2].includes(sequence)) {
    throw new TypeError('A private evidence directory and snapshot sequence 1 or 2 are required');
  }
  return join(directory, `snapshot-${sequence}.json`);
}

function validateReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      Object.keys(receipt).length !== 4 || receipt.sequence !== expected ||
      !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 1 ||
      receipt.byteLength > MAX_SNAPSHOT_BYTES ||
      typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !receipt.provenance || typeof receipt.provenance !== 'object' || Array.isArray(receipt.provenance) ||
      Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) {
    throw new Error('Invalid snapshot evidence receipt or sequence');
  }
}

export function createDemoSnapshotWriter(directory) {
  let sequence = 0, pending = false, failure;
  return Object.freeze({
    async write(snapshot, provenance) {
      if (failure) throw failure;
      if (pending || sequence >= 2) throw new Error('Snapshot evidence permits exactly two sequential writes');
      pending = true;
      try {
        const next = ++sequence;
        const text = JSON.stringify(snapshot);
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) {
          throw new Error('Snapshot evidence exceeds its 1 MiB bound');
        }
        const bytes = Buffer.from(text);
        const receipt = {sequence: next, byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), provenance};
        validateReceipt(receipt, next);
        const file = await open(snapshotEvidencePath(directory, next),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); }
        finally { await file.close(); }
        return receipt;
      } catch (error) { failure = error; throw error; }
      finally { pending = false; }
    },
  });
}

export function createDemoSnapshotReader(directory) {
  let sequence = 0, pending = false, failure;
  return Object.freeze({
    async read(receipt) {
      if (failure) throw failure;
      if (pending || sequence >= 2) throw new Error('Snapshot evidence permits exactly two sequential reads');
      pending = true;
      try {
        validateReceipt(receipt, sequence + 1);
        const path = snapshotEvidencePath(directory, receipt.sequence);
        // O_NONBLOCK also prevents a substituted FIFO from holding admission.
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== receipt.byteLength ||
              (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            throw new Error('Snapshot evidence must be a private regular file of the declared size');
          }
          const buffer = Buffer.alloc(receipt.byteLength + 1);
          let length = 0;
          while (length < buffer.length) {
            const {bytesRead} = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== receipt.byteLength) throw new Error('Snapshot evidence byte length mismatch');
          bytes = buffer.subarray(0, length);
        } finally { await file.close(); }
        if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
          throw new Error('Snapshot evidence SHA-256 mismatch');
        }
        const snapshot = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        sequence++;
        return {snapshot, path, bytes};
      } catch (error) { failure = error; throw error; }
      finally { pending = false; }
    },
  });
}
