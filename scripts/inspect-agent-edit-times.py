"""Was the turn cap raised before or after the execution that hit it?"""

import io
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime

SRC = os.path.expandvars(r'%APPDATA%\agent-workspace\agent-workspace.db')
tmp = tempfile.mkdtemp(prefix='aw-db-')
dst = os.path.join(tmp, 'db.sqlite')
for suffix in ('', '-wal', '-shm'):
    if os.path.exists(SRC + suffix):
        shutil.copyfile(SRC + suffix, dst + suffix)

con = sqlite3.connect(dst)
con.row_factory = sqlite3.Row


def when(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%H:%M:%S') if ms else '-'


cols = [r[1] for r in con.execute('pragma table_info(agents)')]
print('agents columns:', cols)
print()

for a in con.execute('select * from agents'):
    cfg = json.loads(a['config'])
    keys = a.keys()
    print(a['name'], '| maxTurnsPerExecution =', cfg.get('maxTurnsPerExecution'))
    for k in ('created_at', 'updated_at'):
        if k in keys:
            print(f'    {k}: {when(a[k])}  (raw {a[k]})')
print()

print('recent executions:')
agents = {a['id']: a['name'] for a in con.execute('select id, name from agents')}
for e in con.execute('select * from agent_executions order by rowid desc limit 8'):
    err = con.execute(
        "select payload from agent_events where execution_id = ? and type = 'error'", (e['id'],)
    ).fetchone()
    flag = ''
    if err and 'turn limit' in err['payload']:
        flag = '   <-- hit the turn limit'
    print(f"    {agents.get(e['agent_id'], '?'):8} start {when(e['started_at'])} "
          f"end {when(e['ended_at'])} {e['state']}{flag}")
