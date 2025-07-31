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

// ---- Debug / sanity ----
console.log(`Using DISCORD_TOKEN: ${DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using CLIENT_ID: ${CLIENT_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using GUILD_ID: ${GUILD_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using AIRTABLE_TABLE_NAME: ${AIRTABLE_TABLE_NAME || '❌ Not Set'}`);
console.log(`Using SUMMARY_CHANNEL_ID: ${SUMMARY_CHANNEL_ID ? '✅ Set' : '❌ Not Set'}`);

// ---- Airtable setup ----
let queueTable = null;
if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID && AIRTABLE_TABLE_NAME) {
  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
  queueTable = base(AIRTABLE_TABLE_NAME);
} else {
  console.warn('⚠️ Airtable configuration incomplete; queue will not work.');
}

// ---- Coaches config ----
// Active hours per coach (24h EST)
const coachHours = {
  Jeika: { start: 3, end: 4 },
  Tugce: { start: 3, end: 4 },
};
// Discord IDs used for tagging and permission checks
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
};

// ---- Express for health / manual summary ----
const app = express();
app.get('/', (_, res) => res.send('Bot is running!'));

app.get('/run-summary-now', async (req, res) => {
  const today = todayDateEST();
  if (!queueTable) return res.status(500).send('Queue table not configured.');

  try {
    const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    if (!channel?.isTextBased?.()) return res.status(500).send('Summary channel invalid.');

    for (const coach of Object.keys(coachDiscordIds)) {
      const records = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
          sort: [{ field: 'Timestamp', direction: 'asc' }],
        })
        .all();
      if (records.length === 0) continue;

      const byStudent = {};
      records.forEach((r) => {
        const user = r.get('User') || 'Unknown';
        if (!byStudent[user]) {
          byStudent[user] = {
            firstSeen: r.get('Timestamp'),
            channel: r.get('Channel') || 'Unknown',
            messages: [],
          };
        }
        const msg = r.get('Message') || '';
        byStudent[user].messages.push(msg);
        if (
          r.get('Timestamp') &&
          new Date(r.get('Timestamp')) < new Date(byStudent[user].firstSeen)
        ) {
          byStudent[user].firstSeen = r.get('Timestamp');
        }
      });

      let summaryText = `📋 Queue for **${coach}** today (${today})\n<@${coachDiscordIds[coach]}>\n\n`;
      for (const [student, info] of Object.entries(byStudent)) {
        const timeStr = formatEST(info.firstSeen);
        const combined = [...new Set(info.messages)].join(' / ');
        summaryText += `**${student}** (first at ${timeStr} EST in #${info.channel}): "${combined}"\n`;
      }

      await channel.send(summaryText);
    }

    res.send('Summary sent manually.');
  } catch (err) {
    console.error('❌ Manual summary error:', err);
    res.status(500).send('Failed to send summary.');
  }
});

app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

// ---- Self-ping to stay awake ----
setInterval(() => {
  if (SELF_PING_URL) {
    fetch(SELF_PING_URL)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) => console.error('❌ Self-ping failed:', err.message));
  } else {
    console.warn('⚠️ SELF_PING_URL / RENDER_EXTERNAL_URL not set');
  }
}, 180000); // every 3 minutes

// ---- Discord client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));

// ---- Slash commands setup ----
const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription("View who's in the queue for a coach (with per-student summary)")
  .addStringOption((opt) =>
    opt
      .setName('coach')
      .setDescription('Coach name (Jeika or Tugce)')
      .setRequired(true)
      .addChoices(
        { name: 'Jeika', value: 'Jeika' },
        { name: 'Tugce', value: 'Tugce' }
      )
  );

const clearEntryCommand = new SlashCommandBuilder()
  .setName('clearentry')
  .setDescription("Clear a specific student's queue entry for a coach (today)")
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
  .addStringOption((opt) =>
    opt
      .setName('student')
      .setDescription('Student username to remove from queue')
      .setRequired(true)
  );

const clearAllCommand = new SlashCommandBuilder()
  .setName('clearall')
  .setDescription("Clear the entire queue for a coach (all dates, requires confirmation)")
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
  .addBooleanOption((opt) =>
    opt
      .setName('confirm')
      .setDescription('You must set this to true to confirm clearing everything for that coach')
      .setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ---- Helpers ----
function todayDateEST() {
  const now = new Date();
  const estString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const estDate = new Date(estString);
  return estDate.toISOString().split('T')[0];
}
function formatEST(iso) {
  if (!iso) return 'unknown';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
  } catch {
    return iso;
  }
}

// ---- Ready & register commands ----
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
  try {
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [queueCommand.toJSON(), clearEntryCommand.toJSON(), clearAllCommand.toJSON()],
    });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// ---- Interaction handler ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const today = todayDateEST();

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');

    if (!queueTable) {
      return interaction.reply({
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
    }

    try {
      await interaction.deferReply({ flags: 64 });

      const records = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
          sort: [{ field: 'Timestamp', direction: 'asc' }],
        })
        .all();

      if (records.length === 0) {
        await interaction.editReply({
          content: `📭 No one is currently in the queue for **${coach}** today.`,
        });
        return;
      }

      const byStudent = {};
      for (const r of records) {
        const user = r.get('User') || 'Unknown';
        const message = r.get('Message') || '';
        const channel = r.get('Channel') || 'Unknown';
        const timestamp = r.get('Timestamp');

        if (!byStudent[user]) {
          byStudent[user] = {
            firstSeen: timestamp,
            channel,
            messages: [],
          };
        }
        byStudent[user].messages.push(message);
        if (timestamp && new Date(timestamp) < new Date(byStudent[user].firstSeen)) {
          byStudent[user].firstSeen = timestamp;
        }
      }

      let reply = `📋 **Queue for ${coach}** (sorted by first mention):\n\n`;
      let idx = 1;
      for (const [student, info] of Object.entries(byStudent)) {
        const timeStr = formatEST(info.firstSeen);
        const combined = [...new Set(info.messages)].join(' / ');
        reply += `${idx}. **${student}** (first at ${timeStr} EST in #${info.channel}): "${combined}"\n`;
        idx += 1;
      }

      await interaction.editReply(reply);
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: 'There was an error fetching the queue.' });
      } else {
        await interaction.reply({ content: 'There was an error fetching the queue.', flags: 64 });
      }
    }
  } else if (interaction.commandName === 'clearentry') {
    const coach = interaction.options.getString('coach');
    const student = interaction.options.getString('student');
    const callerId = interaction.user.id;

    if (coachDiscordIds[coach] !== callerId) {
      return interaction.reply({
        content: `❌ You are not authorized to clear entries for ${coach}.`,
        flags: 64,
      });
    }

    if (!queueTable) {
      return interaction.reply({
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
    }

    try {
      await interaction.deferReply({ flags: 64 });

      const records = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${coach}", {User} = "${student}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        })
        .all();

      if (records.length === 0) {
        await interaction.editReply({
          content: `ℹ️ No queue entries found for **${student}** under **${coach}** today.`,
        });
        return;
      }

      const ids = records.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 10) {
        await queueTable.destroy(ids.slice(i, i + 10));
      }

      await interaction.editReply({
        content: `🗑️ Cleared ${records.length} entr${records.length === 1 ? 'y' : 'ies'} for **${student}** under **${coach}** today.`,
      });
    } catch (err) {
      console.error('❌ Error clearing entry:', err);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: 'Failed to clear the queue entry.' });
      } else {
        await interaction.reply({ content: 'Failed to clear the queue entry.', flags: 64 });
      }
    }
  } else if (interaction.commandName === 'clearall') {
    const coach = interaction.options.getString('coach');
    const confirm = interaction.options.getBoolean('confirm');
    const callerId = interaction.user.id;

    if (coachDiscordIds[coach] !== callerId) {
      return interaction.reply({
        content: `❌ You are not authorized to clear entries for ${coach}.`,
        flags: 64,
      });
    }

    if (!confirm) {
      return interaction.reply({
        content: `⚠️ This will remove *all* queue entries for **${coach}** (including prior days). If you’re sure, re-run with \`confirm: true\`.`,
        flags: 64,
      });
    }

    if (!queueTable) {
      return interaction.reply({
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
    }

    try {
      await interaction.deferReply({ flags: 64 });

      // No date filter: remove all entries for coach
      const records = await queueTable
        .select({
          filterByFormula: `{Mentioned} = "${coach}"`,
          maxRecords: 1000,
        })
        .all();

      if (records.length === 0) {
        await interaction.editReply({
          content: `ℹ️ No queue entries to clear for **${coach}**.`,
        });
        return;
      }

      const ids = records.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 10) {
        await queueTable.destroy(ids.slice(i, i + 10));
      }

      await interaction.editReply({
        content: `🗑️ Cleared all (${records.length}) queue entr${records.length === 1 ? 'y' : 'ies'} for **${coach}** (all dates).`,
      });
    } catch (err) {
      console.error('❌ Error clearing all entries:', err);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: 'Failed to clear the queue.' });
      } else {
        await interaction.reply({ content: 'Failed to clear the queue.', flags: 64 });
      }
    }
  }
});

// ---- Mention / queue logic ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  console.log(`[MSG] ${message.author.username}: ${message.content}`);

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) return;

  const now = new Date();
  // EST hour for working hours check
  const estHour = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  ).getHours();
  const { start, end } = coachHours[mentionedCoach];

  console.log(
    `[CHECK] Mentioned coach=${mentionedCoach}, est_hour=${estHour}, active window=${start}-${end}`
  );

  if (estHour >= start && estHour < end) {
    console.log(`Within working hours for ${mentionedCoach}; ignoring mention.`);
    return;
  }

  if (!queueTable) {
    console.warn('Airtable not configured; cannot queue.');
    return;
  }

  const today = todayDateEST();
  const username = message.author.username;

  try {
    const filter = `AND({Mentioned} = "${mentionedCoach}", {User} = "${username}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`;

    const existing = await queueTable
      .select({
        filterByFormula: filter,
        maxRecords: 1,
      })
      .firstPage();

    if (existing.length === 0) {
      const created = await queueTable.create({
        User: username,
        Mentioned: mentionedCoach,
        Timestamp: now.toISOString(),
        Message: message.content,
        Channel: message.channel?.name || 'Unknown',
      });
      console.log(
        `📥 New queue entry for ${username} -> ${mentionedCoach} (record ${created.id})`
      );
    } else {
      const existingRecord = existing[0];
      const prevMsg = existingRecord.get('Message') || '';
      const updated = prevMsg ? `${prevMsg}\n- ${message.content}` : message.content;
      await queueTable.update(existingRecord.id, {
        Message: updated,
        Channel: message.channel?.name || 'Unknown',
      });
      console.log(
        `📝 Appended to existing queue entry for ${username} -> ${mentionedCoach}`
      );
    }

    const allRecords = await queueTable
      .select({
        filterByFormula: `AND({Mentioned} = "${mentionedCoach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        sort: [{ field: 'Timestamp', direction: 'asc' }],
      })
      .all();

    const uniqueUsers = [...new Set(allRecords.map((r) => r.get('User')))];
    const position = uniqueUsers.indexOf(username) + 1;

    await message.reply(
      `Thanks for your message! ${mentionedCoach} is currently unavailable. You’ve been added to their queue. You’re #${position} today.`
    );
    console.log(`Queued: ${username} for ${mentionedCoach} (#${position})`);
  } catch (err) {
    console.error('❌ Error handling mention:', err);
  }
});

// ---- Daily summary at 1:00 PM EST ----
cron.schedule(
  '0 13 * * *',
  async () => {
    const today = todayDateEST();
    if (!queueTable) return;

    console.log('🕐 Running daily summary job for', today);

    try {
      const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
      if (!channel?.isTextBased?.()) {
        console.warn('Summary channel not text-based or invalid.');
        return;
      }

      for (const coach of Object.keys(coachDiscordIds)) {
        const records = await queueTable
          .select({
            filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
            sort: [{ field: 'Timestamp', direction: 'asc' }],
          })
          .all();

        if (records.length === 0) continue;

        const byStudent = {};
        records.forEach((r) => {
          const user = r.get('User') || 'Unknown';
          if (!byStudent[user]) {
            byStudent[user] = {
              firstSeen: r.get('Timestamp'),
              channel: r.get('Channel') || 'Unknown',
              messages: [],
            };
          }
          const msg = r.get('Message') || '';
          byStudent[user].messages.push(msg);
          if (
            r.get('Timestamp') &&
            new Date(r.get('Timestamp')) < new Date(byStudent[user].firstSeen)
          ) {
            byStudent[user].firstSeen = r.get('Timestamp');
          }
        });

        let summaryText = `📋 Queue for **${coach}** today (${today})\n<@${coachDiscordIds[coach]}>\n\n`;
        for (const [student, info] of Object.entries(byStudent)) {
          const timeStr = formatEST(info.firstSeen);
          const combined = [...new Set(info.messages)].join(' / ');
          summaryText += `**${student}** (first at ${timeStr} EST in #${info.channel}): "${combined}"\n`;
        }

        await channel.send(summaryText);
      }
    } catch (err) {
      console.error('❌ Summary error:', err);
    }
  },
  {
    timezone: 'America/New_York',
  }
);

// ---- Startup ----
client.login(DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to log in to Discord:', err);
});
