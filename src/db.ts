import Database from "better-sqlite3";

export const db: Database.Database = new Database("bot.sqlite");

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS ha_guild_config (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT NOT NULL,
    notify_role_id TEXT NOT NULL,
    moderator_role_id TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS ha_hijack_reports (
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

  CREATE INDEX IF NOT EXISTS idx_ha_hijack_reports_guild_id
  ON ha_hijack_reports(guild_id);

  -- Multiple images per report. image_channel_id/image_message_id above are kept
  -- only for backward compatibility with rows created before this table existed;
  -- new reports no longer write to them.
  CREATE TABLE IF NOT EXISTS ha_hijack_report_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES ha_hijack_reports(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_ha_hijack_report_images_report_id
  ON ha_hijack_report_images(report_id);

  -- One-time-per-row migration: pull any legacy single image into the new table.
  -- Idempotent - a report already present in ha_hijack_report_images is skipped.
  INSERT INTO ha_hijack_report_images (report_id, channel_id, message_id, position)
  SELECT id, image_channel_id, image_message_id, 0
  FROM ha_hijack_reports
  WHERE image_channel_id IS NOT NULL
    AND image_message_id IS NOT NULL
    AND id NOT IN (SELECT report_id FROM ha_hijack_report_images);
`);

// SQLite has no "ADD COLUMN IF NOT EXISTS", so each new ha_guild_config column
// is added through a small check-then-migrate step, run on every startup but
// only ever applied once per column.
const guildConfigColumns = db.prepare(`PRAGMA table_info(ha_guild_config)`).all() as { name: string }[];
const hasColumn = (name: string) => guildConfigColumns.some((c) => c.name === name);

if (!hasColumn("announcement_channel_id")) {
  // Dedicated channel for cross-server announcements, separate from the
  // review channel (log_channel_id). Existing servers default to their
  // current review channel until they re-run /setup.
  db.exec(`ALTER TABLE ha_guild_config ADD COLUMN announcement_channel_id TEXT`);
  db.exec(`UPDATE ha_guild_config SET announcement_channel_id = log_channel_id WHERE announcement_channel_id IS NULL`);
}

if (!hasColumn("self_announce_enabled")) {
  // Whether a confirmed alert originally reported on this server also gets
  // republished in this server's own announcement channel. Defaults to
  // enabled (1) so existing behavior is unchanged unless a server opts out.
  db.exec(`ALTER TABLE ha_guild_config ADD COLUMN self_announce_enabled INTEGER NOT NULL DEFAULT 1`);
}

// ---- Guild config ----

export interface GuildConfig {
  guild_id: string;
  log_channel_id: string;
  announcement_channel_id: string;
  notify_role_id: string;
  moderator_role_id: string;
  self_announce_enabled: 0 | 1;
}

export function setGuildConfig(
  guildId: string,
  logChannelId: string,
  announcementChannelId: string,
  notifyRoleId: string,
  moderatorRoleId: string,
  selfAnnounceEnabled: boolean
) {
  db.prepare(`
    INSERT INTO ha_guild_config
      (guild_id, log_channel_id, announcement_channel_id, notify_role_id, moderator_role_id, self_announce_enabled)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      log_channel_id=excluded.log_channel_id,
      announcement_channel_id=excluded.announcement_channel_id,
      notify_role_id=excluded.notify_role_id,
      moderator_role_id=excluded.moderator_role_id,
      self_announce_enabled=excluded.self_announce_enabled
  `).run(
    guildId,
    logChannelId,
    announcementChannelId,
    notifyRoleId,
    moderatorRoleId,
    selfAnnounceEnabled ? 1 : 0
  );
}

export function getGuildConfig(guildId: string) {
  return db.prepare(`
    SELECT guild_id, log_channel_id, announcement_channel_id, notify_role_id, moderator_role_id, self_announce_enabled
    FROM ha_guild_config
    WHERE guild_id = ?
  `).get(guildId) as GuildConfig | undefined;
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
  // Legacy single-image columns, no longer populated for new reports.
  // See ha_hijack_report_images for the current, multi-image model.
  image_channel_id: string | null;
  image_message_id: string | null;
  hijack_status: HijackStatus;
  approval_status: ApprovalStatus;
  approved_by_user_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface HijackReportImage {
  channel_id: string;
  message_id: string;
  position: number;
}

export function insertHijackReport(params: {
  guildId: string;
  targetUserId: string;
  reportedByUserId: string;
  message: string | null;
  hijackStatus: HijackStatus;
  images: { channelId: string; messageId: string }[];
}): number {
  const createdAt = new Date().toISOString();

  const insert = db.transaction((p: typeof params) => {
    const result = db.prepare(`
      INSERT INTO ha_hijack_reports
        (guild_id, target_user_id, reported_by_user_id, message, hijack_status, approval_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      p.guildId,
      p.targetUserId,
      p.reportedByUserId,
      p.message,
      p.hijackStatus,
      createdAt
    );

    const reportId = Number(result.lastInsertRowid);

    const insertImage = db.prepare(`
      INSERT INTO ha_hijack_report_images (report_id, channel_id, message_id, position)
      VALUES (?, ?, ?, ?)
    `);

    p.images.forEach((image, index) => {
      insertImage.run(reportId, image.channelId, image.messageId, index);
    });

    return reportId;
  });

  return insert(params);
}

export function getHijackReport(reportId: number) {
  return db.prepare(`SELECT * FROM ha_hijack_reports WHERE id = ?`).get(reportId) as
    | HijackReport
    | undefined;
}

export function getHijackReportImages(reportId: number): HijackReportImage[] {
  return db.prepare(`
    SELECT channel_id, message_id, position
    FROM ha_hijack_report_images
    WHERE report_id = ?
    ORDER BY position ASC
  `).all(reportId) as HijackReportImage[];
}

export function reviewHijackReport(
  reportId: number,
  approvalStatus: "approved" | "rejected",
  approvedByUserId: string
) {
  db.prepare(`
    UPDATE ha_hijack_reports
    SET approval_status = ?, approved_by_user_id = ?, reviewed_at = ?
    WHERE id = ?
  `).run(approvalStatus, approvedByUserId, new Date().toISOString(), reportId);
}

export function getAllGuildConfigs() {
  return db.prepare(`
    SELECT guild_id, log_channel_id, announcement_channel_id, notify_role_id, moderator_role_id, self_announce_enabled
    FROM ha_guild_config
  `).all() as GuildConfig[];
}

export function getApprovedHijackReportsForUser(targetUserId: string) {
  return db.prepare(`
    SELECT * FROM ha_hijack_reports
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
      FROM ha_hijack_reports
      WHERE approval_status = 'approved'
    )
    WHERE rn = 1 AND hijack_status = 'active'
    ORDER BY created_at ASC
  `).all() as ActiveHijackedUser[];
}