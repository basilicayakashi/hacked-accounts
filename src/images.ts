import { Client, Attachment } from "discord.js";
import type { HijackReport } from "./db.js";

const STORAGE_GUILD_ID = process.env.IMAGE_STORAGE_GUILD_ID;
const STORAGE_CHANNEL_ID = process.env.IMAGE_STORAGE_CHANNEL_ID;

export async function uploadImageToStorage(
  client: Client,
  attachment: Attachment
): Promise<{ channelId: string; messageId: string } | null> {
  if (!STORAGE_GUILD_ID || !STORAGE_CHANNEL_ID) return null;

  const guild = await client.guilds.fetch(STORAGE_GUILD_ID).catch(() => null);
  if (!guild) return null;

  const storageChannel = await guild.channels.fetch(STORAGE_CHANNEL_ID).catch(() => null);
  if (!storageChannel?.isTextBased()) return null;

  const sent = await storageChannel.send({ files: [attachment.url] });
  return { channelId: sent.channelId, messageId: sent.id };
}

export async function resolveImageUrl(
  client: Client,
  report: Pick<HijackReport, "image_channel_id" | "image_message_id">
): Promise<string | null> {
  if (!STORAGE_GUILD_ID || !report.image_channel_id || !report.image_message_id) return null;

  const guild = await client.guilds.fetch(STORAGE_GUILD_ID).catch(() => null);
  if (!guild) return null;

  const channel = await guild.channels.fetch(report.image_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const message = await channel.messages.fetch(report.image_message_id).catch(() => null);
  return message?.attachments.first()?.url ?? null;
}