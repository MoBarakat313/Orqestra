import { readFileSync } from 'node:fs';

const [path, expected] = process.argv.slice(2);
if (!path || expected === undefined || readFileSync(path, 'utf8').trim() !== expected) process.exitCode = 1;
