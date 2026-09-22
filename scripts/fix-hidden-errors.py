"""Fixes the three problems the broken tsconfig include had been hiding."""

import io
import json


def patch(path, pairs):
    text = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in text, f'{path}: not found -> {old[:70]}'
        text = text.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(text)
    print('fixed', path)


# 1. The crash: translate() gained a `prices` parameter but the call site and
#    the lookup were never wired up, so `prices` was undefined at runtime.
patch('src/main/runtimes/codex.ts', [
    (
        """    let streamed: { events: AsyncGenerator<ThreadEvent> };""",
        """    // Codex reports tokens, not dollars, so cost is derived from the model's
    // published rates. Resolved once per execution rather than per event.
    const prices = pricesForModel(ctx.agent.config.model);

    let streamed: { events: AsyncGenerator<ThreadEvent> };""",
    ),
    (
        "        for (const translated of translate(event)) {",
        "        for (const translated of translate(event, prices)) {",
    ),
])

# 2. Live-runtime test configs predate the autoCompact field.
text = io.open('tests/integration/live-runtimes.test.ts', encoding='utf-8').read()
before = text.count('config: { maxTurnsPerExecution')
text = text.replace(
    'config: { maxTurnsPerExecution',
    'config: { autoCompact: true, maxTurnsPerExecution',
)
io.open('tests/integration/live-runtimes.test.ts', 'w', encoding='utf-8').write(text)
print(f'fixed tests/integration/live-runtimes.test.ts ({before} configs)')

# 3. Renderer tests are JSX against the DOM: they belong to the web project,
#    not the main-process one.
node_cfg = json.load(io.open('tsconfig.node.json', encoding='utf-8'))
node_cfg['exclude'] = ['tests/e2e/**', 'tests/renderer/**']
io.open('tsconfig.node.json', 'w', encoding='utf-8').write(
    json.dumps(node_cfg, indent=2) + '\n'
)

web_cfg = json.load(io.open('tsconfig.web.json', encoding='utf-8'))
includes = web_cfg.get('include', [])
for pattern in ('tests/renderer/**/*.ts', 'tests/renderer/**/*.tsx'):
    if pattern not in includes:
        includes.append(pattern)
web_cfg['include'] = includes
io.open('tsconfig.web.json', 'w', encoding='utf-8').write(
    json.dumps(web_cfg, indent=2) + '\n'
)
print('moved tests/renderer into the web project')
