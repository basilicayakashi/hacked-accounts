// src/commands.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  getGuildConfig,
  setGuildConfig,
  insertHijackReport,
  getApprovedHijackReportsForUser,
  getActiveHijackedUsers,
  type HijackStatus,
} from "./db.js";

import { uploadImageToStorage, resolveImageUrl } from "./images.js";

// ---- /setup ----

const setupData = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure the bot for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel where alerts will be posted")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .addRoleOption((opt) =>
    opt
      .setName("notify-role")
      .setDescription("Role to notify when a hijack alert is confirmed")
      .setRequired(true)
  )
  .addRoleOption((opt) =>
    opt
      .setName("moderator-role")
      .setDescription("Role allowed to approve or reject reports")
      .setRequired(true)
  );

async function setupExecute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command must be used in a server", ephemeral: true });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const notifyRole = interaction.options.getRole("notify-role", true);
  const moderatorRole = interaction.options.getRole("moderator-role", true);

  setGuildConfig(interaction.guildId, channel.id, notifyRole.id, moderatorRole.id);

  await interaction.reply({
    content:
      `Configuration saved:\n` +
      `Channel: <#${channel.id}>\n` +
      `Notify role: <@&${notifyRole.id}>\n` +
      `Moderator role: <@&${moderatorRole.id}>`,
    ephemeral: true,
  });
}

// ---- /config ----

const configData = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View the bot's current configuration for this server");

async function configExecute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command must be used in a server", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId);
  if (!config) {
    await interaction.reply({
      content: "This server hasn't been configured yet. Run /setup first",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content:
      `**Current configuration**\n` +
      `Channel: <#${config.log_channel_id}>\n` +
      `Notify role: <@&${config.notify_role_id}>\n` +
      `Moderator role: <@&${config.moderator_role_id}>`,
    ephemeral: true,
  });
}

// ---- /status ----

const statusData = new SlashCommandBuilder()
  .setName("view-status")
  .setDescription("View the hijack alert history of a member")
  .addUserOption((opt) =>
    opt.setName("member").setDescription("The member to check").setRequired(true)
  );

// ---- /hacked-list ----

const hackedListData = new SlashCommandBuilder()
  .setName("hacked-list")
  .setDescription("List all accounts currently marked as hacked");

async function hackedListExecute(interaction: ChatInputCommandInteraction) {
  const activeUsers = getActiveHijackedUsers();

  if (activeUsers.length === 0) {
    await interaction.reply({ content: "No accounts are currently marked as hacked.", ephemeral: true });
    return;
  }

  const lines = activeUsers.map((user) => {
    const date = new Date(user.created_at).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });
    return `<@${user.target_user_id}> — since ${date} UTC`;
  });

  await interaction.reply({
    content: `**Currently hacked accounts**\n\n${lines.join("\n")}`,
    ephemeral: true,
  });
}

const alertData = new SlashCommandBuilder()
  .setName("alert")
  .setDescription("Report that a member's account has been hijacked")
  .addUserOption((opt) =>
    opt.setName("member").setDescription("The affected member").setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("status")
      .setDescription("Is the hijack still ongoing?")
      .setRequired(true)
      .addChoices(
        { name: "Ongoing", value: "active" },
        { name: "Resolved", value: "resolved" }
      )
  )
  .addStringOption((opt) =>
    opt.setName("message").setDescription("Optional message or context").setRequired(false)
  )
  .addAttachmentOption((opt) =>
    opt.setName("image").setDescription("Optional screenshot or proof").setRequired(false)
  );

async function alertExecute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command must be used in a server", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId);
  if (!config) {
    await interaction.reply({
      content: "This server hasn't been configured yet. Run /setup first",
      ephemeral: true,
    });
    return;
  }

  const target = interaction.options.getUser("member", true);
  const hijackStatus = interaction.options.getString("status", true) as HijackStatus;
  const message = interaction.options.getString("message");
  const attachment = interaction.options.getAttachment("image");

  if (attachment && !attachment.contentType?.startsWith("image/")) {
    await interaction.reply({ content: "The attached file must be an image.", ephemeral: true });
    return;
  }

  let imageChannelId: string | null = null;
  let imageMessageId: string | null = null;

  if (attachment) {
    const stored = await uploadImageToStorage(interaction.client, attachment);
    if (stored) {
      imageChannelId = stored.channelId;
      imageMessageId = stored.messageId;
    }
  }

  const reportId = insertHijackReport({
    guildId: interaction.guildId,
    targetUserId: target.id,
    reportedByUserId: interaction.user.id,
    message,
    imageChannelId,
    imageMessageId,
    hijackStatus,
  });

  const channel = await interaction.guild?.channels.fetch(config.log_channel_id);
  if (channel?.isTextBased()) {
    const statusLabel = hijackStatus === "active" ? "🔴 Ongoing" : "🟢 Resolved";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`alert_approve_${reportId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`alert_reject_${reportId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content:
        `<@&${config.moderator_role_id}> New hijack report awaiting review\n` +
        `**Member:** <@${target.id}>\n` +
        `**Status:** ${statusLabel}\n` +
        `**Reported by:** <@${interaction.user.id}>` +
        (message ? `\n**Message:** ${message}` : ""),
      components: [row],
      ...(attachment ? { files: [attachment.url] } : {}),
    });
  }

  await interaction.reply({ content: "Your report has been submitted for review", ephemeral: true });
}

async function statusExecute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("member", true);
  const reports = getApprovedHijackReportsForUser(target.id);

  if (reports.length === 0) {
    await interaction.reply({
      content: `<@${target.id}> is unknown — no hijack reports on record.`,
      ephemeral: true,
    });
    return;
  }

  const lines = await Promise.all(
    reports.map(async (report) => {
      const statusLabel = report.hijack_status === "active" ? "🔴 Ongoing" : "🟢 Resolved";
      const guildName = interaction.client.guilds.cache.get(report.guild_id)?.name ?? "Unknown server";
      const date = new Date(report.created_at).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      });
      const imageUrl = await resolveImageUrl(interaction.client, report);

      return (
        `**${date} UTC** — ${statusLabel}\n` +
        `Reported in: ${guildName}` +
        (report.message ? `\nMessage: ${report.message}` : "") +
        (imageUrl ? `\nImage: ${imageUrl}` : "")
      );
    })
  );

  await interaction.reply({
    content: `**Hijack history for <@${target.id}>**\n\n${lines.join("\n\n")}`,
    ephemeral: true,
  });
}

// ---- Export ----

export const commands = [
  { data: setupData, execute: setupExecute },
  { data: alertData, execute: alertExecute },
  { data: configData, execute: configExecute },
  { data: statusData, execute: statusExecute },
  { data: hackedListData, execute: hackedListExecute },
];