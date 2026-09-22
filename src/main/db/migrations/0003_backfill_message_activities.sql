-- Final activity reactions for runs that finished before activity reactions
-- existed. Only the recorded outcome of each run is used -- no intermediate
-- states are invented -- and only the latest run per (message, agent) counts.
INSERT OR IGNORE INTO `message_activities`
  (`id`, `message_id`, `conversation_id`, `agent_id`, `execution_id`, `state`, `emoji`, `detail`, `active`, `revision`, `created_at`, `updated_at`)
SELECT
  'act:backfill:' || e.`id`,
  e.`triggered_by_message_id`,
  e.`conversation_id`,
  e.`agent_id`,
  e.`id`,
  CASE
    WHEN e.`state` = 'completed' THEN 'completed'
    WHEN e.`error` = 'The application stopped while this execution was running.' THEN 'interrupted'
    WHEN e.`state` = 'cancelled' AND e.`error` = 'The execution timed out.' THEN 'failed'
    WHEN e.`state` = 'cancelled' THEN 'cancelled'
    ELSE 'failed'
  END,
  CASE
    WHEN e.`state` = 'completed' THEN '✅'
    WHEN e.`error` = 'The application stopped while this execution was running.' THEN '⚠️'
    WHEN e.`state` = 'cancelled' AND e.`error` = 'The execution timed out.' THEN '❌'
    WHEN e.`state` = 'cancelled' THEN '🚫'
    ELSE '❌'
  END,
  CASE WHEN e.`state` = 'cancelled' AND e.`error` = 'The execution timed out.' THEN 'timeout' ELSE NULL END,
  0,
  1,
  e.`started_at`,
  COALESCE(e.`ended_at`, e.`started_at`)
FROM `agent_executions` e
JOIN `messages` m ON m.`id` = e.`triggered_by_message_id`
WHERE e.`state` IN ('completed', 'failed', 'cancelled')
  AND e.`started_at` = (
    SELECT MAX(e2.`started_at`)
    FROM `agent_executions` e2
    WHERE e2.`triggered_by_message_id` = e.`triggered_by_message_id`
      AND e2.`agent_id` = e.`agent_id`
  );
