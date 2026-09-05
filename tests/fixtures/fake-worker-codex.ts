import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2];
if (arg === '--version') {
  console.log('codex-cli worker-fixture');
} else if (arg === '--help') {
  console.log('Commands:\n  app-server  Start the worker fixture protocol server');
} else {
  const scenario = process.env.ORQESTRA_WORKER_SCENARIO ?? 'success';
  const input = createInterface({ input: process.stdin });
  let cwd = process.cwd();
  const threadId = 'thread-fixture';
  const turnId = 'turn-fixture';
  const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
  const complete = (status: 'completed' | 'failed' | 'interrupted'): void => {
    if (status === 'completed') {
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'message-1', text: '{"summary":"fixture completed"}', phase: 'final_answer' } } });
    }
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status, error: status === 'failed' ? { message: 'private fixture failure', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } } : null } } });
  };
  input.on('line', line => {
    const request = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: { decision?: string } };
    if (request.method === 'initialized') return;
    if (request.id === 'approval-1' && request.result) {
      if (request.result.decision !== 'cancel') process.exitCode = 12;
      complete('interrupted');
      return;
    }
    if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'worker-fixture' } });
    else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: 'gpt-5.6-terra', displayName: 'Fixture Terra', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null } });
    else if (request.method === 'thread/start') {
      cwd = String(request.params?.cwd ?? cwd);
      send({ id: request.id, result: { thread: { id: threadId, sessionId: threadId, ephemeral: true } } });
    } else if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      setTimeout(() => {
        if (scenario === 'exit-after-start') process.exit(9);
        else if (scenario === 'approval') {
          send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command-1', startedAtMs: Date.now(), command: 'private-command --safe-preview', cwd, reason: 'fixture approval' } });
        } else if (scenario === 'failure') complete('failed');
        else if (scenario !== 'hang') {
          writeFileSync(join(cwd, 'result.txt'), 'done\n');
          send({ method: 'turn/diff/updated', params: { threadId, turnId, diff: 'fixture diff' } });
          complete('completed');
        }
      }, 20);
    } else if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} });
      setTimeout(() => complete('interrupted'), 5);
    } else {
      send({ id: request.id, error: { code: -32601, message: 'unexpected fixture operation' } });
    }
  });
}
