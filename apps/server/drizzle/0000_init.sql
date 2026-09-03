CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`provider` text NOT NULL,
	`auth_type` text NOT NULL,
	`imap_host` text,
	`imap_port` integer,
	`imap_secure` integer DEFAULT true NOT NULL,
	`smtp_host` text,
	`smtp_port` integer,
	`smtp_secure` integer DEFAULT true NOT NULL,
	`password_enc` text,
	`oauth_client_id` text,
	`oauth_refresh_token_enc` text,
	`oauth_access_token_enc` text,
	`oauth_token_expires_at` integer,
	`oauth_scope` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`last_error_at` integer,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`sync_interval_seconds` integer DEFAULT 300 NOT NULL,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_email_uq` ON `accounts` (`user_id`,`email`);--> statement-breakpoint
CREATE INDEX `accounts_status_idx` ON `accounts` (`status`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`filename` text,
	`content_type` text,
	`size` integer,
	`sha256` text,
	`part_id` text,
	`content_id` text,
	`is_inline` integer DEFAULT false NOT NULL,
	`downloaded_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_sha_idx` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`delimiter` text,
	`special_use` text,
	`subscribed` integer DEFAULT true NOT NULL,
	`uid_validity` integer,
	`uid_next` integer,
	`highest_modseq` text,
	`total_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_account_path_uq` ON `folders` (`account_id`,`path`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`uid` integer,
	`message_id` text,
	`in_reply_to` text,
	`references_json` text,
	`thread_id` text,
	`subject` text,
	`from_name` text,
	`from_address` text,
	`to_json` text,
	`cc_json` text,
	`bcc_json` text,
	`reply_to_json` text,
	`sent_at` integer,
	`received_at` integer,
	`snippet` text,
	`body_text` text,
	`body_html` text,
	`has_attachments` integer DEFAULT false NOT NULL,
	`size` integer,
	`is_read` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_answered` integer DEFAULT false NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`flags_json` text,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_folder_uid_uq` ON `messages` (`folder_id`,`uid`);--> statement-breakpoint
CREATE INDEX `messages_folder_received_idx` ON `messages` (`folder_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `messages_account_received_idx` ON `messages` (`account_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `messages_message_id_idx` ON `messages` (`account_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`ip` text,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`started_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`new_messages` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_started_idx` ON `sync_runs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);