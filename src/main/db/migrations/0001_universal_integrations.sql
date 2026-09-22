CREATE TABLE `agent_tool_grants` (
	`agent_id` text NOT NULL,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`mode` text DEFAULT 'ask' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `server_id`, `tool_name`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_grants_server_idx` ON `agent_tool_grants` (`server_id`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text DEFAULT '' NOT NULL,
	`args` text NOT NULL,
	`cwd` text DEFAULT '' NOT NULL,
	`env_keys` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`auth_method` text DEFAULT 'none' NOT NULL,
	`auth_header_name` text,
	`secret_id` text,
	`headers` text NOT NULL,
	`secret_header_names` text NOT NULL,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`auto_connect` integer DEFAULT false NOT NULL,
	`allow_insecure` integer DEFAULT false NOT NULL,
	`approved_fingerprint` text,
	`tools_cache` text NOT NULL,
	`resources_cache` text NOT NULL,
	`prompts_cache` text NOT NULL,
	`server_info` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`preset` text NOT NULL,
	`category` text NOT NULL,
	`base_url` text NOT NULL,
	`auth_method` text NOT NULL,
	`auth_header_name` text,
	`secret_id` text,
	`headers` text NOT NULL,
	`secret_header_names` text NOT NULL,
	`options` text NOT NULL,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`models` text NOT NULL,
	`last_check` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_idx` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `description` text DEFAULT '' NOT NULL;