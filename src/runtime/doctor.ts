import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface Diagnostic {
  ready: boolean;
  node: { version: string; supported: boolean };
  codex: { executable: string; version: string | null; status: 'detected' | 'incompatible' | 'unavailable' };
  messages: string[];
  liveExecutionImplemented: false;
}

/** Check root help first: older CLIs can treat unknown subcommands as prompts. */
export function advertisesAppServer(help: string): boolean {
  return /^\s+app-server(?:\s|$)/mu.test(help);
}

export async function diagnose(executable = 'codex'): Promise<Diagnostic> {
  const supported = Number(process.versions.node.split('.')[0]) >= 22;
  const result: Diagnostic = {
    ready: false,
    node: { version: process.versions.node, supported },
    codex: { executable, version: null, status: 'unavailable' },
    messages: ['Diagnostics do not sign in, update tools, or start a model turn.'],
    liveExecutionImplemented: false,
  };
  if (!supported) result.messages.push('Node.js 22 or newer is required.');
  try {
    const options = { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true };
    const { stdout: version } = await execute(executable, ['--version'], options);
    result.codex.version = version.trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, 200);
    const { stdout: help } = await execute(executable, ['--help'], options);
    if (advertisesAppServer(help)) {
      result.codex.status = 'detected';
      result.ready = supported;
      result.messages.push('The CLI advertises App Server. Protocol compatibility and model availability are not yet verified.');
    } else {
      result.codex.status = 'incompatible';
      result.messages.push('This Codex CLI does not advertise app-server. Install a compatible official Codex CLI or select one with --codex <path>. Offline planning remains available.');
    }
  } catch {
    result.messages.push('Could not inspect the Codex executable within the diagnostic timeout. Check installation/PATH, or use --codex <path>.');
  }
  return result;
}
