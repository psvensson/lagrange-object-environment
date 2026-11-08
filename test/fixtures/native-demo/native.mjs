import {fork} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [mode, heartbeat] = process.argv.slice(2);
const ready = () => process.stdout.write('{"event":"native-viewer-ready"}\n');
if (mode === 'early-exit') process.exit(0);
if (mode.startsWith('descendant-') || mode === 'held-pipe') {
  const child = fork(new URL('./descendant.mjs', import.meta.url), [mode, heartbeat ?? ''],
    {execArgv: [], stdio: ['ignore', mode === 'held-pipe' ? 'inherit' : 'ignore', 'ignore', 'ipc']});
  child.once('message', () => {
    ready();
    if (heartbeat) writeFileSync(heartbeat + '.payload', String(process.pid));
    if (mode.includes('-exit') || mode === 'held-pipe') process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
} else {
  if (mode !== 'never-ready') ready();
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { if (mode !== 'term-resistant') { clearInterval(timer); process.exit(0); } });
  if (mode === 'close') setTimeout(() => { clearInterval(timer); process.exit(0); }, 60);
}
// Fixture watchdog is never part of the production launcher.
setTimeout(() => process.exit(0), 2000);
