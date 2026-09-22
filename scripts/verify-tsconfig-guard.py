"""Proves the tsconfig coverage guard actually fails on the real corruption.

Reintroduces the exact damage (`/**/` stripped from every glob), runs the
guard, then restores the file no matter what happened.
"""

import io
import json
import shutil
import subprocess
import sys

PATH = 'tsconfig.node.json'
BACKUP = PATH + '.guardcheck.bak'

shutil.copyfile(PATH, BACKUP)
try:
    cfg = json.load(io.open(PATH, encoding='utf-8'))
    cfg['include'] = [p.replace('/**/', '') for p in cfg['include']]
    io.open(PATH, 'w', encoding='utf-8').write(json.dumps(cfg, indent=2) + '\n')
    print('corrupted include ->', cfg['include'])

    result = subprocess.run(
        [
            'npx', 'cross-env', 'ELECTRON_RUN_AS_NODE=1', 'electron',
            './node_modules/vitest/vitest.mjs', 'run',
            'tests/unit/tsconfig-coverage.test.ts',
        ],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        shell=True,
    )
    output = result.stdout + result.stderr
    for line in output.splitlines():
        if any(m in line for m in ('Tests ', 'lost its', 'not being', 'AssertionError', 'FAIL')):
            print(line)
    print('exit code:', result.returncode)
    sys.exit(0 if result.returncode != 0 else 1)
finally:
    shutil.move(BACKUP, PATH)
    print('restored', PATH)
