"""Finds the config surface that controls MCP tool approval in Codex."""

import io
import re
import subprocess

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

data = io.open(BIN, 'rb').read()


def show(needle, before=500, after=500, limit=4):
    hits = [m.start() for m in re.finditer(re.escape(needle), data)]
    print(f'===== {needle.decode()} : {len(hits)} hit(s)')
    seen = set()
    shown = 0
    for off in hits:
        window = data[max(0, off - before): off + after]
        key = window[:80]
        if key in seen:
            continue
        seen.add(key)
        for piece in re.findall(rb'[ -~]{10,}', window):
            print('   ', piece.decode('ascii', 'replace'))
        print('    ' + '-' * 60)
        shown += 1
        if shown >= limit:
            break
    print()


show(b'tools_approval_mode')
show(b'destructive_enabled')
show(b'McpToolsApproval', before=300, after=300)
show(b'approval_mode', before=200, after=300, limit=3)
