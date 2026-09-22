"""Did anything Roger produced before the cut-off reach the conversation?"""

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


failed = con.execute(
    "select * from agent_executions where state = 'failed' order by rowid desc limit 1"
).fetchone()
print('failed execution:', failed['id'], when(failed['started_at']), '->', when(failed['ended_at']))
print('conversation:', failed['conversation_id'])
print()

print('--- text the runtime emitted (not deltas) ---')
for ev in con.execute(
    "select payload from agent_events where execution_id = ? and type = 'text' order by rowid",
    (failed['id'],),
):
    body = json.loads(ev['payload']).get('text', '')
    print('   ', body[:150].replace('\n', ' '))
print()

print('--- messages stored in that conversation, last 8 ---')
for m in con.execute(
    'select * from messages where conversation_id = ? order by rowid desc limit 8',
    (failed['conversation_id'],),
):
    keys = m.keys()
    at = when(m['created_at']) if 'created_at' in keys else '?'
    kind = m['kind'] if 'kind' in keys else '?'
    body = (m['body'] or '')[:110].replace('\n', ' ')
    print(f"   {at} [{m['sender_type']}/{kind}] {body}")
print()

sess = con.execute(
    'select * from agent_sessions where conversation_id = ?', (failed['conversation_id'],)
).fetchall()
print('--- saved runtime sessions for this conversation ---')
for s in sess:
    print('   ', dict(s))
