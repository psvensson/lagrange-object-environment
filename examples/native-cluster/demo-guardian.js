import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export const DEMO_PYTHON = '/usr/bin/python3';
export const DEMO_GUARDIAN = fileURLToPath(new URL('./demo-guardian.py', import.meta.url));

export async function verifyDemoGuardian() {
  const result = await promisify(execFile)(DEMO_PYTHON, ['-I', '-S', DEMO_GUARDIAN, '--check'], {
    timeout: 5000, maxBuffer: 16384, env: {LC_ALL: 'C'},
  });
  if (result.stdout !== 'demo-guardian-capable/v1\n' || result.stderr !== '') {
    throw new Error('Linux descendant supervisor is unavailable');
  }
}
