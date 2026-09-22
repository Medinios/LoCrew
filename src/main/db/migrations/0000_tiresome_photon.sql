CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_exec_idx` ON `agent_events` (`execution_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`task_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`triggered_by_message_id` text,
	`chain_id` text NOT NULL,
	`chain_depth` integer DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exec_agent_idx` ON `agent_executions` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `exec_conv_idx` ON `agent_executions` (`conversation_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `exec_chain_idx` ON `agent_executions` (`chain_id`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`runtime_type` text NOT NULL,
	`runtime_session_id` text,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_pair_idx` ON `agent_sessions` (`agent_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`runtime_type` text NOT NULL,
	`avatar` text DEFAULT '' NOT NULL,
	`avatar_color` text DEFAULT '#7C6CF6' NOT NULL,
	`working_directory` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`status_detail` text,
	`permissions` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_idx` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `application_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `member_type`, `member_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conv_members_member_idx` ON `conversation_members` (`member_type`,`member_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`topic` text,
	`autonomy_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_type` text NOT NULL,
	`sender_id` text NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`body` text NOT NULL,
	`mentions` text NOT NULL,
	`task_id` text,
	`execution_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conv_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_exec_idx` ON `messages` (`execution_id`);--> statement-breakpoint
CREATE TABLE `task_assignees` (
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `agent_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_conv_idx` ON `tasks` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `workspace_permissions` (
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`access` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `workspace_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_idx` ON `workspaces` (`path`);