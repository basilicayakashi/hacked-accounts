import { ButtonInteraction } from "discord.js";
import { getGuildConfig, getHijackReport, reviewHijackReport, getAllGuildConfigs } from "./db.js";
import { resolveImageUrl } from "./images.js";

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

  // Compte le nombre de modérateurs (nécessite l'intent GuildMembers + un cache à jour)
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
  // Si moderatorCount === 1, le seul modérateur peut approuver même sa propre alerte.

  const approvalStatus = action === "approve" ? "approved" : "rejected";
  reviewHijackReport(reportId, approvalStatus, interaction.user.id);

  if (approvalStatus === "approved") {
    const statusLabel = report.hijack_status === "active" ? "🔴 Ongoing" : "🟢 Resolved";
    const originGuildName = interaction.guild.name;
    const imageUrl = await resolveImageUrl(interaction.client, report);

    const allConfigs = getAllGuildConfigs();

    for (const guildConfig of allConfigs) {
      const targetGuild = interaction.client.guilds.cache.get(guildConfig.guild_id);
      if (!targetGuild) continue;

      const notifyChannel = await targetGuild.channels
        .fetch(guildConfig.log_channel_id)
        .catch(() => null);
      if (!notifyChannel?.isTextBased()) continue;

      try {
        await notifyChannel.send({
          content:
            `<@&${guildConfig.notify_role_id}> Hijack alert confirmed\n` +
            `**Member:** <@${report.target_user_id}>\n` +
            `**Status:** ${statusLabel}\n` +
            `**Originally reported in:** ${originGuildName}` +
            (report.message ? `\n**Message:** ${report.message}` : ""),
          ...(imageUrl ? { files: [imageUrl] } : {}),
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