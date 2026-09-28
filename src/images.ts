import { Client, Attachment } from "discord.js";

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

// Uploads several attachments one by one (Discord doesn't support batching
// unrelated files into separate re-hosted messages in a single call), keeping
// their original order. Attachments that fail to upload are simply dropped.
export async function uploadImagesToStorage(
  client: Client,
  attachments: Attachment[]
): Promise<{ channelId: string; messageId: string }[]> {
  const results: { channelId: string; messageId: string }[] = [];

  for (const attachment of attachments) {
    const stored = await uploadImageToStorage(client, attachment);
    if (stored) results.push(stored);
  }

  return results;
}

export async function resolveImageUrl(
  client: Client,
  ref: { channelId: string; messageId: string }
): Promise<string | null> {
  if (!STORAGE_GUILD_ID) return null;

  const guild = await client.guilds.fetch(STORAGE_GUILD_ID).catch(() => null);
  if (!guild) return null;

  const channel = await guild.channels.fetch(ref.channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  return message?.attachments.first()?.url ?? null;
}

// Resolves every stored image for a report back to a live CDN URL, in order.
// Refs that fail to resolve (deleted message, missing storage config, etc.)
// are dropped rather than breaking the whole list.
export async function resolveImageUrls(
  client: Client,
  refs: { channel_id: string; message_id: string }[]
): Promise<string[]> {
  const urls = await Promise.all(
    refs.map((ref) =>
      resolveImageUrl(client, { channelId: ref.channel_id, messageId: ref.message_id })
    )
  );

  return urls.filter((url): url is string => url !== null);
}