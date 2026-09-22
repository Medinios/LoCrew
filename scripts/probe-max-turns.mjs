/**
 * What does `num_turns` count, relative to the `maxTurns` we set?
 *
 * Roger stopped with error_max_turns at num_turns 25 while his stored config
 * said 50, so the two numbers are not in the same unit -- or the config was
 * different at the time. This measures it against a known small cap instead of
 * reasoning about it.
 *
 * Costs a few cents of real usage.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const CAP = 3;

const run = query({
  prompt:
    'Use the Read tool to read package.json, then the Glob tool to list *.json in this directory, ' +
    'then the Read tool on tsconfig.json, then summarise. Do them one at a time, not in parallel.',
  options: {
    maxTurns: CAP,
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Glob'],
  },
});

let assistantMessages = 0;
let toolUses = 0;

for await (const message of run) {
  if (message.type === 'assistant') {
    assistantMessages += 1;
    for (const block of message.message.content ?? []) {
      if (block.type === 'tool_use') toolUses += 1;
    }
  }
  if (message.type === 'result') {
    console.log('--- result ---');
    console.log('  maxTurns we set :', CAP);
    console.log('  subtype         :', message.subtype);
    console.log('  num_turns       :', message.num_turns);
    console.log('  assistant msgs  :', assistantMessages);
    console.log('  tool_use blocks :', toolUses);
    console.log('  cost usd        :', message.total_cost_usd);
  }
}
