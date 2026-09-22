CREATE TABLE `message_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`state` text NOT NULL,
	`emoji` text NOT NULL,
	`detail` text,
	`active` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_activities_message_agent_idx` ON `message_activities` (`message_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `message_activities_conv_idx` ON `message_activities` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `message_activities_exec_idx` ON `message_activities` (`execution_id`);--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_reactions_unique_idx` ON `message_reactions` (`message_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE INDEX `message_reactions_conv_idx` ON `message_reactions` (`conversation_id`);