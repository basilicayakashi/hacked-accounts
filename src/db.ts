// src/db.ts
import Database from "better-sqlite3";

export const db: Database.Database = new Database("bot.sqlite");

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT NOT NULL,
    notify_role_id TEXT NOT NULL,
    moderator_role_id TEXT NOT NULL
  );

 CREATE TABLE IF NOT EXISTS hijack_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    reported_by_user_id TEXT NOT NULL,
    message TEXT,
    image_channel_id TEXT,
    image_message_id TEXT,
    hijack_status TEXT NOT NULL CHECK (hijack_status IN ('active', 'resolved')),
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    approved_by_user_id TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_hijack_reports_guild_id
  ON hijack_reports(guild_id);
`);

// ---- Guild config ----

export function setGuildConfig(
  guildId: string,
  logChannelId: string,
  notifyRoleId: string,
  moderatorRoleId: string
) {
  db.prepare(`
    INSERT INTO guild_config (guild_id, log_channel_id, notify_role_id, moderator_role_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      log_channel_id=excluded.log_channel_id,
      notify_role_id=excluded.notify_role_id,
      moderator_role_id=excluded.moderator_role_id
  `).run(guildId, logChannelId, notifyRoleId, moderatorRoleId);
}

export function getGuildConfig(guildId: string) {
  return db.prepare(`
    SELECT guild_id, log_channel_id, notify_role_id, moderator_role_id
    FROM guild_config
    WHERE guild_id = ?
  `).get(guildId) as
    | { guild_id: string; log_channel_id: string; notify_role_id: string; moderator_role_id: string }
    | undefined;
}

// ---- Hijack reports ----

export type HijackStatus = "active" | "resolved";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface HijackReport {
  id: number;
  guild_id: string;
  target_user_id: string;
  reported_by_user_id: string;
  message: string | null;
  image_channel_id: string | null;
  image_message_id: string | null;
  hijack_status: HijackStatus;
  approval_status: ApprovalStatus;
  approved_by_user_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export function insertHijackReport(params: {
  guildId: string;
  targetUserId: string;
  reportedByUserId: string;
  message: string | null;
  imageChannelId: string | null;
  imageMessageId: string | null;
  hijackStatus: HijackStatus;
}): number {
  const createdAt = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO hijack_reports
      (guild_id, target_user_id, reported_by_user_id, message, image_channel_id, image_message_id, hijack_status, approval_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    params.guildId,
    params.targetUserId,
    params.reportedByUserId,
    params.message,
    params.imageChannelId,
    params.imageMessageId,
    params.hijackStatus,
    createdAt
  );

  return Number(result.lastInsertRowid);
}

export function getHijackReport(reportId: number) {
  return db.prepare(`SELECT * FROM hijack_reports WHERE id = ?`).get(reportId) as
    | HijackReport
    | undefined;
}

export function reviewHijackReport(
  reportId: number,
  approvalStatus: "approved" | "rejected",
  approvedByUserId: string
) {
  db.prepare(`
    UPDATE hijack_reports
    SET approval_status = ?, approved_by_user_id = ?, reviewed_at = ?
    WHERE id = ?
  `).run(approvalStatus, approvedByUserId, new Date().toISOString(), reportId);
}

export function getAllGuildConfigs() {
  return db.prepare(`
    SELECT guild_id, log_channel_id, notify_role_id, moderator_role_id
    FROM guild_config
  `).all() as Array<{
    guild_id: string;
    log_channel_id: string;
    notify_role_id: string;
    moderator_role_id: string;
  }>;
}

export function getApprovedHijackReportsForUser(targetUserId: string) {
  return db.prepare(`
    SELECT * FROM hijack_reports
    WHERE target_user_id = ? AND approval_status = 'approved'
    ORDER BY created_at ASC
  `).all(targetUserId) as HijackReport[];
}

export interface ActiveHijackedUser {
  target_user_id: string;
  created_at: string;
}

export function getActiveHijackedUsers(): ActiveHijackedUser[] {
  return db.prepare(`
    SELECT target_user_id, created_at
    FROM (
      SELECT target_user_id, hijack_status, created_at,
        ROW_NUMBER() OVER (PARTITION BY target_user_id ORDER BY created_at DESC) AS rn
      FROM hijack_reports
      WHERE approval_status = 'approved'
    )
    WHERE rn = 1 AND hijack_status = 'active'
    ORDER BY created_at ASC
  `).all() as ActiveHijackedUser[];
}