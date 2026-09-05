import { extname } from 'node:path';

/** Run JavaScript entrypoints directly with Node, including on Windows. No shell. */
export function executableCommand(executable: string): { command: string; prefix: string[] } {
  return ['.js', '.mjs', '.cjs'].includes(extname(executable).toLowerCase())
    ? { command: process.execPath, prefix: [executable] }
    : { command: executable, prefix: [] };
}
