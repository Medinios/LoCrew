"""Scans the vendored Codex binary for the approval error and nearby config keys.

The CLI is compiled Rust, so its accepted config keys only exist as string
literals inside the executable. Reading them there is more reliable than
guessing from documentation.
"""

import io
import os
import re
import subprocess
import sys

BIN = subprocess.run(
    [
        'node', '-e',
        "const{createRequire}=require('module');"
        "const r=createRequire(process.cwd()+'/x.js');"
        "const p=r.resolve('@openai/codex-win32-x64/package.json');"
        "const{dirname,join}=require('path');"
        "process.stdout.write(join(dirname(p),'vendor','x86_64-pc-windows-msvc','bin','codex.exe'))"
    ],
    capture_output=True, text=True, shell=True,
).stdout.strip()

print('binary:', BIN)
print('size:', os.path.getsize(BIN), 'bytes')
print()

data = io.open(BIN, 'rb').read()

TARGETS = [
    b'requires approval, but approval policy',
    b'auto_approve',
    b'always_allow',
    b'approved_tools',
    b'enabled_tools',
    b'trust_level',
    b'startup_timeout',
    b'bearer_token_env_var',
]

for needle in TARGETS:
    hits = [m.start() for m in re.finditer(re.escape(needle), data)]
    print(f'--- {needle.decode()} : {len(hits)} hit(s)')
    for off in hits[:2]:
        window = data[max(0, off - 220): off + 220]
        readable = re.findall(rb'[ -~]{6,}', window)
        for piece in readable:
            print('    ', piece.decode('ascii', 'replace'))
        print()
