-- 手写迁移：messages 的 FTS5 全文索引。
-- {{FTS_TOKENIZER}} 由 migrate.ts 在运行期替换：优先 trigram（SQLite>=3.34，中文子串可搜），
-- 不可用时降级为 unicode61（此时中日韩检索能力受限，migrate 会打日志警告）。
-- 用 external content（content='messages'）避免正文重复存储；列名必须与 messages 的真实列名一致。
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`subject`,
	`from_name`,
	`from_address`,
	`body_text`,
	`body_html`,
	content='messages',
	content_rowid='id',
	tokenize='{{FTS_TOKENIZER}}'
);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(`rowid`, `subject`, `from_name`, `from_address`, `body_text`, `body_html`)
	VALUES (new.`id`, new.`subject`, new.`from_name`, new.`from_address`, new.`body_text`, new.`body_html`);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `subject`, `from_name`, `from_address`, `body_text`, `body_html`)
	VALUES ('delete', old.`id`, old.`subject`, old.`from_name`, old.`from_address`, old.`body_text`, old.`body_html`);
END;
--> statement-breakpoint
-- 限定 OF 列：切换已读/加星等高频 UPDATE 不应触发重建索引
CREATE TRIGGER `messages_fts_au` AFTER UPDATE OF `subject`, `from_name`, `from_address`, `body_text`, `body_html` ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `subject`, `from_name`, `from_address`, `body_text`, `body_html`)
	VALUES ('delete', old.`id`, old.`subject`, old.`from_name`, old.`from_address`, old.`body_text`, old.`body_html`);
	INSERT INTO `messages_fts`(`rowid`, `subject`, `from_name`, `from_address`, `body_text`, `body_html`)
	VALUES (new.`id`, new.`subject`, new.`from_name`, new.`from_address`, new.`body_text`, new.`body_html`);
END;
