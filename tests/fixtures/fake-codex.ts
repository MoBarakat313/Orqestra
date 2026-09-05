import { createInterface } from 'node:readline';

const arg = process.argv[2];
if (arg === '--version') {
  console.log('codex-cli fixture');
} else if (arg === '--help') {
  console.log('Commands:\n  app-server  Start the fixture protocol server');
} else {
  const scenario = arg === 'app-server' ? 'normal' : arg;
  const input = createInterface({ input: process.stdin });
  const send = (value: unknown): void => {
    const line = JSON.stringify(value) + '\n';
    if (scenario === 'split') {
      const midpoint = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, midpoint));
      setTimeout(() => process.stdout.write(line.slice(midpoint)), 10);
    } else process.stdout.write(line);
  };
  if (scenario === 'stubborn') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  input.on('line', line => {
    const request = JSON.parse(line) as { id?: number; method?: string; params?: { cursor?: string } };
    if (request.method === 'initialized') return;
    if (scenario === 'hang' || scenario === 'stubborn') return;
    if (scenario === 'exit') process.exit(7);
    if (scenario === 'malformed') { process.stdout.write('{broken\n'); return; }
    if (scenario === 'oversized') { process.stdout.write('x'.repeat(500)); return; }
    if (scenario === 'unknown-id') { send({ id: 999, result: {} }); return; }
    if (scenario === 'error') { send({ id: request.id, error: { code: -32001, message: 'secret-auth-value' } }); return; }
    if (scenario === 'server-request') { send({ id: 'server-request-id', method: 'account/chatgptAuthTokens/refresh', params: { secret: 'private-fixture' } }); return; }
    if (request.method === 'initialize') {
      if (scenario !== 'split') send({ method: 'fixture/notification', params: { private: 'do-not-display' } });
      send({ id: request.id, result: { userAgent: 'fixture', platformFamily: process.platform } });
    } else if (request.method === 'account/read') {
      send({ id: request.id, result: { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'fixture-private' }, requiresOpenaiAuth: true } });
    } else if (request.method === 'model/list') {
      const next = request.params?.cursor === 'second';
      send({ id: request.id, result: {
        data: [{ id: next ? 'two' : 'one', model: next ? 'gpt-6-astra' : 'gpt-5.6-terra', displayName: next ? 'Fixture Astra' : 'Fixture Terra', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'fixture' }] }],
        nextCursor: next ? null : 'second',
      } });
    } else {
      // Discovery must never request login, thread creation, or model execution.
      send({ id: request.id, error: { code: -32601, message: 'Unexpected operation' } });
      process.exitCode = 10;
    }
  });
}
