"""Dumps the most recent Codex execution's events straight from the live DB.

Copies the database (plus WAL/SHM) first so the running app keeps its lock.
"""

import io
import json
import os
import shutil
import sqlite3
import tempfile

SRC = os.path.expandvars(r'%APPDATA%\agent-workspace\agent-workspace.db')

tmp = tempfile.mkdtemp(prefix='aw-db-')
dst = os.path.join(tmp, 'db.sqlite')
for suffix in ('', '-wal', '-shm'):
    if os.path.exists(SRC + suffix):
        shutil.copyfile(SRC + suffix, dst + suffix)

con = sqlite3.connect(dst)
con.row_factory = sqlite3.Row

tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
print('tables:', tables)
print()

agents = con.execute('select id, name, runtime_type from agents').fetchall()
for a in agents:
    print('agent:', a['id'][:8], a['name'], a['runtime_type'])
print()

execs = con.execute(
    'select * from agent_executions order by rowid desc limit 6'
).fetchall()

for e in execs:
    keys = e.keys()
    agent_id = e['agent_id'] if 'agent_id' in keys else '?'
    name = next((a['name'] for a in agents if a['id'] == agent_id), '?')
    print('=' * 70)
    print('execution', e['id'][:8], '| agent', name, '| state', e['state'])
    for k in ('error', 'error_message', 'cost_usd', 'started_at', 'ended_at'):
        if k in keys and e[k] is not None:
            print(f'  {k}: {e[k]}')

    events = con.execute(
        'select * from agent_events where execution_id = ? order by rowid', (e['id'],)
    ).fetchall()
    for ev in events:
        payload = ev['payload']
        try:
            payload = json.loads(payload)
        except Exception:
            pass
        text = json.dumps(payload, ensure_ascii=False)
        print(f'  [{ev["type"]}] {text[:400]}')
    print()
