import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = process.argv[3];
if (!marker) process.exit(2);
if (process.argv[2] === '--child') {
  setTimeout(() => writeFileSync(marker, 'descendant survived\n'), 1000);
} else {
  const started = process.argv[2];
  if (!started) process.exit(2);
  writeFileSync(started, 'started\n');
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', marker], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
}
