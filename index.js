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
// Hours are in 24h local time (you can adjust per coach individually)
const coachHours = {
  Jeika: { start: 3, end: 4 },
  Tugce: { start: 3, end: 4 },
};
// Discord IDs used for tagging in summaries
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
};

// ---- Express for health / manual summary ----
const app = express();
app.get('/', (_, res) => res.send('Bot is running!'));

// manual trigger for summary
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

      // Build grouped summary per student
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
        // update firstSeen if earlier
        if (r.get('Timestamp') && new Date(r.get('Timestamp')) < new Date(byStudent[user].firstSeen)) {
          byStudent[user].firstSeen = r.get('Timestamp');
        }
      });

      let summaryText = `📋 Queue for **${coach}** today (${today})\n<@${coachDiscordIds[coach]}>\n\n`;
      for (const [student, info] of Object.entries(byStudent)) {
        const timeStr = formatEST(info.firstSeen);
        const combined = [...new Set(info.messages)].join(' / ');
        summaryText += `**${student}** (first at ${timeStr} in #${info.channel}): "${combined}"\n`;
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
  .setDescription("View who's in the queue for a coach (with summary)")
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

// ---- Helpers ----
/**
 * Returns current date string in EST (YYYY-MM-DD)
 */
function todayDateEST() {
  const now = new Date();
  // Use Intl to shift to America/New_York
  const est = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const d = new Date(est);
  return d.toISOString().split('T')[0];
}

/**
 * Format ISO timestamp to human-readable EST time
 */
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
    console.log('🔁 Registering slash command /queue...');
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
  const today = todayDateEST();

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

    // Group by student and accumulate
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

    // Build reply text
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
  // Determine current hour in coach's local (assuming server is UTC, use EST offset if needed)
  const hourLocal = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  ).getHours();
  const { start, end } = coachHours[mentionedCoach];

  console.log(
    `[CHECK] Mentioned coach=${mentionedCoach}, est_hour=${hourLocal}, active window=${start}-${end}`
  );

  // If within working hours, skip queueing
  if (hourLocal >= start && hourLocal < end) {
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

    // recalc position for logging
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
