import {writeFileSync} from 'node:fs';
const [mode, heartbeat] = process.argv.slice(2);
if (heartbeat) writeFileSync(heartbeat + '.pid', String(process.pid));
const timer = setInterval(() => { if (heartbeat) writeFileSync(heartbeat, String(Date.now())); }, 5);
process.on('SIGTERM', () => {
  if (mode.includes('resistant')) return;
  if (mode === 'held-pipe') {
    setTimeout(() => { process.stdout.write('descendant-finished\n'); process.exit(0); }, 80);
  } else { clearInterval(timer); process.exit(mode.includes('abnormal') ? 7 : 0); }
});
process.send('ready'); process.disconnect();
setTimeout(() => process.exit(0), 2000);
