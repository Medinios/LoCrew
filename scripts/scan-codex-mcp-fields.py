"""Dumps the full field list of Codex's MCP server config struct."""

import io
import os
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

for needle in [b'RawMcpServerConfig', b'default_tools_approval_mode', b'ToolsApprovalMode',
               b'McpToolApprovalMode']:
    hits = [m.start() for m in re.finditer(re.escape(needle), data)]
    print(f'===== {needle.decode()} : {len(hits)} hit(s)')
    for off in hits[:3]:
        window = data[max(0, off - 700): off + 320]
        for piece in re.findall(rb'[ -~]{8,}', window):
            print('   ', piece.decode('ascii', 'replace'))
        print('    ' + '-' * 60)
    print()
