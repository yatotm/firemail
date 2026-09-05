-- 服务端运行日志。设置 → 日志 读它。
-- 存进库而不是滚动文件：日志页要按级别过滤、按子串搜、取日期区间，
-- 这三件事在文本文件上都得自己实现一遍。控制台那一路不受影响，照常写 stdout。
-- 文件名是手工从 drizzle-kit 的 0001_* 改成 0002_* 的：0001 已经被手写的
-- FTS 迁移占了，而那个迁移刻意不在 drizzle 的 journal 里（它有运行期占位符）。
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` integer NOT NULL,
	`message` text NOT NULL,
	`meta` text,
	`account_id` integer,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_at_idx` ON `logs` (`at`);--> statement-breakpoint
CREATE INDEX `logs_level_at_idx` ON `logs` (`level`,`at`);
