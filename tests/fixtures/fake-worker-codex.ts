import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const arg = process.argv[2];
if (arg === '--version') {
  console.log('codex-cli worker-fixture');
} else if (arg === '--help') {
  console.log('Commands:\n  app-server  Start the worker fixture protocol server\n  exec  Run one JSONL fixture turn');
} else if (arg === 'exec') {
  const scenario = process.env.ORQESTRA_WORKER_SCENARIO ?? 'success';
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    if (!Buffer.concat(chunks).length) process.exitCode = 11;
    const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
    send({ type: 'thread.started', thread_id: 'direct-thread-fixture' });
    send({ type: 'turn.started' });
    if (scenario === 'benchmark-direct-failure') {
      send({ type: 'turn.failed', error: { message: 'private direct fixture failure' } });
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(process.cwd(), 'result.txt'), 'done\n');
    send({ type: 'item.completed', item: { type: 'agent_message', text: 'private direct fixture response' } });
    if (scenario !== 'direct-missing-usage') send({
      type: 'turn.completed',
      usage: { input_tokens: 90, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 },
    });
    else send({ type: 'turn.completed' });
    if (scenario === 'direct-nonzero-after-complete') process.exitCode = 1;
  });
} else {
  const scenario = process.env.ORQESTRA_WORKER_SCENARIO ?? 'success';
  const input = createInterface({ input: process.stdin });
  let cwd = process.cwd();
  let resumedThread = false;
  const threadId = 'thread-fixture';
  const turnId = 'turn-fixture';
  const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
  const complete = (status: 'completed' | 'failed' | 'interrupted'): void => {
    if (status === 'completed') {
      send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'message-1', text: '{"summary":"fixture completed"}', phase: 'final_answer' } } });
    }
    if (scenario !== 'missing-usage' && status !== 'interrupted') {
      send({ method: 'thread/tokenUsage/updated', params: {
        threadId, turnId,
        tokenUsage: {
          last: { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20, reasoningOutputTokens: 8, totalTokens: 120 },
          total: resumedThread
            ? { inputTokens: 300, cachedInputTokens: 180, cacheWriteInputTokens: 10, outputTokens: 70, reasoningOutputTokens: 25, totalTokens: 370 }
            : { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20, reasoningOutputTokens: 8, totalTokens: 120 },
          modelContextWindow: 200000,
        },
      } });
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
    else if (request.method === 'account/read') {
      if (scenario === 'exit-during-discovery') process.exit(9);
      else send({ id: request.id, result: { account: { type: process.env.ORQESTRA_ACCOUNT_MODE ?? 'chatgpt' }, requiresOpenaiAuth: true } });
    }
    else if (request.method === 'model/list') send({ id: request.id, result: { data: scenario === 'model-unavailable' ? [] : [{ model: 'gpt-5.6-terra', displayName: 'Fixture Terra', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null } });
    else if (request.method === 'thread/start' || request.method === 'thread/resume') {
      if (scenario === 'repair-requires-resume' && request.method === 'thread/start' && existsSync(join(cwd, 'result.txt'))) {
        send({ id: request.id, error: { code: -32000, message: 'repair did not resume' } });
        return;
      }
      cwd = String(request.params?.cwd ?? cwd);
      resumedThread = request.method === 'thread/resume';
      send({ id: request.id, result: { thread: { id: threadId, sessionId: threadId, ephemeral: true } } });
      if (request.method === 'thread/resume') send({ method: 'thread/tokenUsage/updated', params: {
        threadId, turnId: 'turn-previous',
        tokenUsage: {
          last: { inputTokens: 80, cachedInputTokens: 40, cacheWriteInputTokens: 2, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 90 },
          total: { inputTokens: 200, cachedInputTokens: 120, cacheWriteInputTokens: 5, outputTokens: 50, reasoningOutputTokens: 17, totalTokens: 250 },
          modelContextWindow: 200000,
        },
      } });
    } else if (request.method === 'turn/start') {
      if (process.env.ORQESTRA_WORKER_COUNT_FILE) appendFileSync(process.env.ORQESTRA_WORKER_COUNT_FILE, 'turn\n');
      const packageId = basename(cwd).replace(/^pkg-/u, '');
      if (scenario.startsWith('coordinate') && process.env.ORQESTRA_WORKER_EVENTS_FILE) {
        appendFileSync(process.env.ORQESTRA_WORKER_EVENTS_FILE, `start,${packageId},${Date.now()}\n`);
      }
      send({ id: request.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      setTimeout(() => {
        if (scenario === 'exit-after-start') process.exit(9);
        else if (scenario === 'exit-after-edit') {
          writeFileSync(join(cwd, 'result.txt'), 'incomplete\n');
          process.exit(9);
        }
        else if (scenario === 'approval') {
          send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command-1', startedAtMs: Date.now(), command: 'private-command --safe-preview', cwd, reason: 'fixture approval' } });
        } else if (scenario === 'failure') complete('failed');
        else if (scenario === 'rename') {
          renameSync(join(cwd, 'README.md'), join(cwd, 'result.txt'));
          send({ method: 'turn/diff/updated', params: { threadId, turnId, diff: 'fixture rename diff' } });
          complete('completed');
        }
        else if (scenario.startsWith('coordinate')) {
          const failure = process.env.ORQESTRA_FAIL_PACKAGE;
          const dependency = process.env.ORQESTRA_REQUIRED_DEPENDENCY?.split(':');
          if (failure === packageId || (dependency?.[0] === packageId && !existsSync(join(cwd, 'packages', `${dependency[1]}.txt`)))) {
            if (process.env.ORQESTRA_WORKER_EVENTS_FILE) appendFileSync(process.env.ORQESTRA_WORKER_EVENTS_FILE, `end,${packageId},${Date.now()}\n`);
            complete('failed');
          } else if (scenario === 'coordinate-hang') {
            // Wait for turn/interrupt so cancellation behavior can be tested.
          } else {
            mkdirSync(join(cwd, 'packages'), { recursive: true });
            writeFileSync(join(cwd, 'packages', `${packageId}.txt`), `done ${packageId}\n`);
            if (process.env.ORQESTRA_OUT_OF_SCOPE_PACKAGE === packageId) writeFileSync(join(cwd, 'outside.txt'), 'out of scope\n');
            if (process.env.ORQESTRA_WORKER_EVENTS_FILE) appendFileSync(process.env.ORQESTRA_WORKER_EVENTS_FILE, `end,${packageId},${Date.now()}\n`);
            send({ method: 'turn/diff/updated', params: { threadId, turnId, diff: 'fixture coordination diff' } });
            complete('completed');
          }
        }
        else if (scenario !== 'hang') {
          const content = scenario.startsWith('repair') && !existsSync(join(cwd, 'result.txt')) ? 'incomplete\n' : 'done\n';
          writeFileSync(join(cwd, 'result.txt'), content);
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
