"""Shows the execution that hit the turn limit and the agent's configured cap."""

import io
import json
import os
import shutil
import sqlite3
import tempfile
from collections import Counter

SRC = os.path.expandvars(r'%APPDATA%\agent-workspace\agent-workspace.db')

tmp = tempfile.mkdtemp(prefix='aw-db-')
dst = os.path.join(tmp, 'db.sqlite')
for suffix in ('', '-wal', '-shm'):
    if os.path.exists(SRC + suffix):
        shutil.copyfile(SRC + suffix, dst + suffix)

con = sqlite3.connect(dst)
con.row_factory = sqlite3.Row

for a in con.execute('select id, name, runtime_type, config from agents'):
    cfg = json.loads(a['config'])
    print(f"{a['name']:10} ({a['runtime_type']})")
    for k in ('model', 'effort', 'maxTurnsPerExecution', 'timeoutMs', 'autoCompact'):
        print(f"    {k}: {cfg.get(k)}")
print()

execs = con.execute('select * from agent_executions order by rowid desc limit 8').fetchall()
agents = {a['id']: a['name'] for a in con.execute('select id, name from agents')}

for e in execs:
    events = con.execute(
        'select type, payload from agent_events where execution_id = ? order by rowid', (e['id'],)
    ).fetchall()
    kinds = Counter(ev['type'] for ev in events)

    err = [json.loads(ev['payload']) for ev in events if ev['type'] == 'error']
    cost = [json.loads(ev['payload']) for ev in events if ev['type'] == 'cost']

    dur = (e['ended_at'] - e['started_at']) / 1000 if e['ended_at'] and e['started_at'] else None
    print('=' * 70)
    print(f"{agents.get(e['agent_id'], '?'):10} | {e['state']:10} | "
          f"${e['cost_usd'] or 0:.4f} | {dur if dur is None else round(dur, 1)}s")
    print('    events:', dict(kinds))
    if cost:
        c = cost[-1]
        print(f"    turns used: {c.get('turns')}  in:{c.get('inputTokens')} out:{c.get('outputTokens')}")
    for x in err:
        print('    ERROR:', x.get('message'))

    tools = Counter(
        json.loads(ev['payload']).get('name')
        for ev in events if ev['type'] == 'tool_use'
    )
    if tools:
        print('    tools:', dict(tools))
