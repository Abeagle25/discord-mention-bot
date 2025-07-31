import express from 'express';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
} from 'discord.js';
import dotenv from 'dotenv';
import Airtable from 'airtable';
import cron from 'node-cron';
import fetch from 'node-fetch';

dotenv.config();

// ---- Config / env ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const SELF_PING_URL = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL || ''}`;

// ---- Sanity/debug output ----
console.log(`Using DISCORD_TOKEN: ${DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using CLIENT_ID: ${CLIENT_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using GUILD_ID: ${GUILD_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using AIRTABLE_TABLE_NAME: ${AIRTABLE_TABLE_NAME || '❌ Not Set'}`);
console.log(`Using SUMMARY_CHANNEL_ID: ${SUMMARY_CHANNEL_ID ? '✅ Set' : '❌ Not Set'}`);

// ---- Airtable ----
let queueTable = null;
if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID && AIRTABLE_TABLE_NAME) {
  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
  queueTable = base(AIRTABLE_TABLE_NAME);
} else {
  console.warn('⚠️ Airtable configuration incomplete. Queueing will fail.');
}

// ---- Coaches config ----
const coachHours = {
  Jeika: { start: 3, end: 4 },
  Tugce: { start: 3, end: 4 },
};
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '1225908721785026580',
};

// ---- Express for health / keep-alive ----
const app = express();
app.get('/', (_, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

// Self-ping to stay awake (every 3 minutes)
setInterval(() => {
  if (SELF_PING_URL) {
    fetch(SELF_PING_URL)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) => console.error('❌ Self-ping failed:', err.message));
  } else {
    console.warn('⚠️ No SELF_PING_URL / RENDER_EXTERNAL_URL provided');
  }
}, 180000); // 3 minutes

// ---- Discord client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Error/log events
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));

// ---- Slash command definition ----
const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription("View who's in the queue for a coach")
  .addStringOption((opt) =>
    opt
      .setName('coach')
      .setDescription('Coach name (Jeika or Tugce)')
      .setRequired(true)
      .addChoices(
        { name: 'Jeika', value: 'Jeika' },
        { name: 'Tugce', value: 'Tugce' }
      )
  )
  .toJSON();

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ---- Ready & registration ----
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}`);

  // Register slash command (guild-scoped)
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [queueCommand],
    });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// ---- Interaction handler (/queue) ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'queue') return;

  const coach = interaction.options.getString('coach');
  const today = new Date().toISOString().split('T')[0];

  if (!queueTable) {
    await interaction.reply({
      content: '⚠️ Queue table not configured properly.',
      flags: 64, // ephemeral
    });
    return;
  }

  try {
    const records = await queueTable
      .select({
        filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        sort: [{ field: 'Timestamp', direction: 'asc' }],
      })
      .all();

    if (records.length === 0) {
      await interaction.reply({
        content: `No one is currently in the queue for **${coach}**.`,
        flags: 64,
      });
    } else {
      const users = [...new Set(records.map((r) => r.get('user') || 'Unknown'))];
      const formatted = users.map((u, i) => `${i + 1}. ${u}`).join('\n');
      await interaction.reply({
        content: `📋 Queue for **${coach}**:\n${formatted}`,
        flags: 64,
      });
    }
  } catch (err) {
    console.error('❌ Error fetching queue:', err);
    await interaction.reply({
      content: 'There was an error fetching the queue.',
      flags: 64,
    });
  }
});

// ---- Message mention / queue logic ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Debug log for every incoming message
  console.log(`[MSG] ${message.author.username}: ${message.content}`);

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) {
    // nothing relevant mentioned
    return;
  }

  const now = new Date();
  const hour = now.getHours();
  const { start, end } = coachHours[mentionedCoach];

  console.log(`[CHECK] Mentioned coach=${mentionedCoach}, hour=${hour}, hours=${start}-${end}`);

  // If within working hours, skip queueing
  if (hour >= start && hour < end) {
    console.log(`Within working hours for ${mentionedCoach}; ignoring.`);
    return;
  }

  if (!queueTable) {
    console.warn('Airtable not configured; cannot queue.');
    return;
  }

  const today = now.toISOString().split('T')[0];
  const username = message.author.username;

  try {
    // Prevent duplicate same-day entry
    const existing = await queueTable
      .select({
        filterByFormula: `AND({Mentioned} = "${mentionedCoach}", {user} = "${username}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        maxRecords: 1,
      })
      .firstPage();

    if (existing.length === 0) {
      await queueTable.create({
        user: username,
        Mentioned: mentionedCoach,
        Timestamp: now.toISOString(),
      });
      console.log(`📥 New queue entry for ${username} -> ${mentionedCoach}`);
    } else {
      console.log(`📝 ${username} already in queue for ${mentionedCoach} today; not duplicating.`);
    }

    // Recalculate unique position
    const records = await queueTable
      .select({
        filterByFormula: `AND({Mentioned} = "${mentionedCoach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        sort: [{ field: 'Timestamp', direction: 'asc' }],
      })
      .all();

    const uniqueUsers = [...new Set(records.map((r) => r.get('user')))];
    const position = uniqueUsers.indexOf(username) + 1;

    await message.reply(
      `Thanks for your message! ${mentionedCoach} is currently unavailable. You’ve been added to their queue. You’re #${position} today.`
    );
    console.log(`Queued: ${username} for ${mentionedCoach} (#${position})`);
  } catch (err) {
    console.error('❌ Error handling mention:', err);
  }
});

// ---- Daily summary (10 PM server time) ----
cron.schedule('0 22 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  if (!queueTable) return;

  try {
    const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    if (!channel?.isTextBased?.()) return;

    for (const coach of Object.keys(coachDiscordIds)) {
      const records = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
          sort: [{ field: 'Timestamp', direction: 'asc' }],
        })
        .all();

      if (records.length === 0) continue;

      const users = [...new Set(records.map((r) => r.get('user') || 'Unknown'))];
      const list = users.map((u, i) => `${i + 1}. ${u}`).join('\n');
      const mention = `<@${coachDiscordIds[coach]}>`;

      await channel.send(`📋 Queue for ${coach} today (${today}):\n${mention}\n${list}`);
    }
  } catch (err) {
    console.error('❌ Summary error:', err);
  }
});

// ---- Startup ----
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to log in to Discord:', err);
});
