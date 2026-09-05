import { access } from 'node:fs/promises';

let entry = new URL('./runtime/cli.js', import.meta.url);
try {
  await access(entry);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  entry = new URL('../../../dist/src/cli.js', import.meta.url);
  try { await access(entry); }
  catch { throw new Error('Orqestra helper is missing. Build the source checkout or reinstall this project skill.'); }
}
await import(entry.href);
