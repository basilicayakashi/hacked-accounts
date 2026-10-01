import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  ButtonInteraction,
} from "discord.js";
import {
  getGuildConfig,
  getHijackReport,
  reviewHijackReport,
  getAllGuildConfigs,
  getHijackReportImages,
} from "./db.js";
import { resolveImageUrls } from "./images.js";
import { commands } from "./commands.js";

// ---- Client & connexion ----

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Connecté en tant que ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = commands.find((c) => c.data.name === interaction.commandName);
    if (command) await command.execute(interaction);
  } else if (interaction.isButton()) {
    await handleReportReview(interaction);
  }
});

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
  const body = commands.map((c) => c.data.toJSON());

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), { body });
  console.log("Slash commands enregistrées.");
}

client.login(process.env.DISCORD_TOKEN).then(registerCommands);

// ---- Handler de review des rapports ----

export async function handleReportReview(interaction: ButtonInteraction) {
  if (!interaction.guildId || !interaction.guild) return;

  const [, action, reportIdStr] = interaction.customId.split("_"); // alert_approve_12 / alert_reject_12
  const reportId = Number(reportIdStr);

  const config = getGuildConfig(interaction.guildId);
  if (!config) {
    await interaction.reply({ content: "This server isn't configured.", ephemeral: true });
    return;
  }

  const report = getHijackReport(reportId);
  if (!report) {
    await interaction.reply({ content: "Report not found.", ephemeral: true });
    return;
  }

  if (report.approval_status !== "pending") {
    await interaction.reply({ content: "This report has already been reviewed.", ephemeral: true });
    return;
  }

  const reviewerMember = await interaction.guild.members.fetch(interaction.user.id);
  if (!reviewerMember.roles.cache.has(config.moderator_role_id)) {
    await interaction.reply({ content: "You are not authorized to review reports.", ephemeral: true });
    return;
  }

  await interaction.guild.members.fetch();
  const moderatorRole = interaction.guild.roles.cache.get(config.moderator_role_id);
  const moderatorCount = moderatorRole?.members.size ?? 0;

  const reviewerIsReporter = interaction.user.id === report.reported_by_user_id;

  if (reviewerIsReporter && moderatorCount > 1) {
    await interaction.reply({
      content: "You submitted this report, so another staff member must review it.",
      ephemeral: true,
    });
    return;
  }

  const approvalStatus = action === "approve" ? "approved" : "rejected";
  reviewHijackReport(reportId, approvalStatus, interaction.user.id);

  if (approvalStatus === "approved") {
    const statusLabel = report.hijack_status === "active" ? "🔴 Ongoing" : "🟢 Resolved";
    const originGuildName = interaction.guild.name;

    const imageRefs = getHijackReportImages(reportId);
    const imageUrls = await resolveImageUrls(interaction.client, imageRefs);

    const allConfigs = getAllGuildConfigs();

    // Confirmed alerts are published to every configured server's dedicated
    // announcement channel, except the server the report originated from
    // gets skipped if it has opted out via self_announce_enabled.
    for (const guildConfig of allConfigs) {
      const isOriginGuild = guildConfig.guild_id === report.guild_id;
      if (isOriginGuild && !guildConfig.self_announce_enabled) continue;

      const targetGuild = interaction.client.guilds.cache.get(guildConfig.guild_id);
      if (!targetGuild) continue;

      const announcementChannel = await targetGuild.channels
        .fetch(guildConfig.announcement_channel_id)
        .catch(() => null);
      if (!announcementChannel?.isTextBased()) continue;

      try {
        await announcementChannel.send({
          content:
            `<@&${guildConfig.notify_role_id}> Hijack alert confirmed\n` +
            `**Member:** <@${report.target_user_id}>\n` +
            `**Status:** ${statusLabel}\n` +
            `**Originally reported in:** ${originGuildName}` +
            (report.message ? `\n**Message:** ${report.message}` : ""),
          ...(imageUrls.length ? { files: imageUrls } : {}),
        });
      } catch {
        continue;
      }
    }
  }

  const reviewLabel = approvalStatus === "approved" ? "✅ Approved" : "❌ Rejected";
  await interaction.update({
    content: `${interaction.message.content}\n\n**Review:** ${reviewLabel} by <@${interaction.user.id}>`,
    components: [],
  });
}