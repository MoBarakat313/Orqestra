import { readFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (!paths.length || paths.some(path => !readFileSync(path, 'utf8').startsWith('done '))) process.exitCode = 1;
