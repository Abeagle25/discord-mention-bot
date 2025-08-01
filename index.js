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
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID; // e.g., 1176961256029171773
const PORT = process.env.PORT || 3000;
const SELF_PING_URL =
  process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL || ''}`;

// ---- Debug / sanity ----
console.log(`Using DISCORD_TOKEN: ${DISCORD_TOKEN ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using CLIENT_ID: ${CLIENT_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(`Using GUILD_ID: ${GUILD_ID ? '✅ Set' : '❌ Not Set'}`);
console.log(
  `Using AIRTABLE_TABLE_NAME: ${AIRTABLE_TABLE_NAME || '❌ Not Set'}`
);
console.log(
  `Using SUMMARY_CHANNEL_ID: ${SUMMARY_CHANNEL_ID ? '✅ Set' : '❌ Not Set'}`
);
console.log(
  `Using REQUIRED_ROLE_ID: ${REQUIRED_ROLE_ID ? '✅ Set' : '❌ Not Set'}`
);

// ---- Airtable setup ----
let queueTable = null;
if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID && AIRTABLE_TABLE_NAME) {
  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
  queueTable = base(AIRTABLE_TABLE_NAME);
} else {
  console.warn(
    '⚠️ Airtable configuration incomplete; queue will not work.'
  );
}

// ---- Coaches config ----
// Active hours per coach (EST). Michael has two windows.
const coachHours = {
  Jeika: [{ start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } }], // 10AM–3PM
  Tugce: [{ start: { hour: 8, minute: 0 }, end: { hour: 18, minute: 0 } }], // 8AM–6PM
  Sandro: [{ start: { hour: 6, minute: 0 }, end: { hour: 16, minute: 0 } }], // 6AM–4PM
  Michael: [
    { start: { hour: 9, minute: 0 }, end: { hour: 13, minute: 0 } }, // 9AM-1PM
    { start: { hour: 20, minute: 0 }, end: { hour: 24, minute: 0 } }, // 8PM-12AM
  ],
  Divine: [{ start: { hour: 8, minute: 0 }, end: { hour: 17, minute: 0 } }], // 8AM–5PM
  Phil: [{ start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } }], // 8AM–4PM
};
// Discord IDs
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
  Sandro: '814382156633079828',
  Michael: '673171818437279755',
  Divine: '692545355849400320',
  Phil: '1058164184292016148',
};

// ---- State tracking ----
const reminderSent = {}; // coachName -> date string
const queueEnabled = {}; // coachName -> bool
const friendlyReplied = {}; // coachName -> { userName: date }

Object.keys(coachDiscordIds).forEach((c) => {
  queueEnabled[c] = true;
  friendlyReplied[c] = {};
});

// ---- Time helpers (EST) ----
function getESTNow() {
  const now = new Date();
  const estString = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
  });
  return new Date(estString);
}
function todayDateEST() {
  return getESTNow().toISOString().split('T')[0];
}
function formatEST(iso) {
  if (!iso) return 'unknown';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
    });
  } catch {
    return iso;
  }
}
function inWindow(estDate, window) {
  const nowMin = estDate.getHours() * 60 + estDate.getMinutes();
  const startMin = (window.start.hour % 24) * 60 + (window.start.minute || 0);
  let endHour = window.end.hour;
  if (endHour === 24) endHour = 0;
  const endMin = endHour * 60 + (window.end.minute || 0);
  if (window.end.hour === 24) {
    return nowMin >= startMin && nowMin < 24 * 60;
  }
  return nowMin >= startMin && nowMin < endMin;
}
function isWithinCoachHours(coach, estDate) {
  const windows = coachHours[coach] || [];
  return windows.some((w) => inWindow(estDate, w));
}
function isWeekendEST(date) {
  const day = date.getDay(); // 0 Sunday, 6 Saturday
  return day === 0 || day === 6;
}
function getNextAvailability(coach, fromDate) {
  const estNow = new Date(fromDate);
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  const fmtStart = (windowStart) => {
    const h = windowStart.hour % 24;
    const m = windowStart.minute || 0;
    const date = new Date(estNow);
    date.setHours(h, m, 0, 0);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
    });
  };

  const nowMinutes = estNow.getHours() * 60 + estNow.getMinutes();
  const todayWindows = coachHours[coach] || [];

  for (const w of todayWindows) {
    const startMin = (w.start.hour % 24) * 60 + (w.start.minute || 0);
    if (nowMinutes < startMin) {
      return fmtStart(w.start);
    }
  }

  for (let offset = 1; offset <= 7; offset++) {
    const candidate = new Date(estNow);
    candidate.setDate(estNow.getDate() + offset);
    const day = candidate.getDay();
    if (day === 0 || day === 6) continue; // skip weekends
    const windows = coachHours[coach] || [];
    if (windows.length === 0) continue;
    const firstWindow = windows[0];
    const timeStr = fmtStart(firstWindow.start);
    return `${dayNames[candidate.getDay()]} at ${timeStr}`;
  }

  return 'unknown';
}

// ---- Express / manual summary ----
const app = express();
app.get('/', (_, res) => res.send('Bot is running!'));

async function buildAndSendSummaryForCoach(coach) {
  const today = todayDateEST();
  if (!queueTable) return;
  const records = await queueTable
    .select({
      filterByFormula: `AND({Mentioned} = "${coach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
      sort: [{ field: 'Timestamp', direction: 'asc' }],
    })
    .all();
  if (records.length === 0) return;

  const byStudent = {};

  records.forEach((r) => {
    const user = r.get('User') || 'Unknown';
    const msg = r.get('Message') || '';
    const channel = r.get('Channel') || 'Unknown';
    const timestamp = r.get('Timestamp');

    if (!byStudent[user]) {
      byStudent[user] = {
        firstSeen: timestamp,
        channels: new Set([channel]),
        messages: [],
      };
    } else {
      byStudent[user].channels.add(channel);
      if (
        timestamp &&
        new Date(timestamp) < new Date(byStudent[user].firstSeen)
      ) {
        byStudent[user].firstSeen = timestamp;
      }
    }

    byStudent[user].messages.push({
      text: msg,
      timestamp,
      channel,
    });
  });

  let summaryText = `📋 Queue for **${coach}** today (${today}):\n<@${coachDiscordIds[coach]}>\n\n`;
  let studentIdx = 1;
  for (const [student, info] of Object.entries(byStudent)) {
    const firstSeenStr = formatEST(info.firstSeen);
    const channelList = [...info.channels].map((c) => `#${c}`).join(', ');
    summaryText += `${studentIdx}. **${student}** (first at ${firstSeenStr} EST in ${channelList}):\n`;
    const seenMsgs = new Set();
    for (const m of info.messages) {
      const timeStr = formatEST(m.timestamp);
      const key = `${m.text}||${m.channel}||${timeStr}`;
      if (seenMsgs.has(key)) continue;
      seenMsgs.add(key);
      summaryText += `   - [${timeStr} EST in #${m.channel}] ${m.text}\n`;
    }
    studentIdx += 1;
  }

  const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
  if (channel?.isTextBased?.()) {
    await channel.send(summaryText);
  }
}

app.get('/run-summary-now', async (req, res) => {
  try {
    for (const coach of Object.keys(coachDiscordIds)) {
      await buildAndSendSummaryForCoach(coach);
    }
    res.send('Summary sent manually.');
  } catch (err) {
    console.error('❌ Manual summary error:', err);
    res.status(500).send('Failed to send summary.');
  }
});

app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

// ---- Self-ping ----
setInterval(() => {
  if (SELF_PING_URL) {
    fetch(SELF_PING_URL)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) =>
        console.error('❌ Self-ping failed:', err.message || err)
      );
  } else {
    console.warn('⚠️ SELF_PING_URL / RENDER_EXTERNAL_URL not set');
  }
}, 180000);

// ---- Discord client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Logging
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));

// ---- Slash commands ----
const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription("View who's in the queue for a coach (with per-student summary)")
  .addStringOption((opt) =>
    opt
      .setName('coach')
      .setDescription('Coach name')
      .setRequired(true)
      .addChoices(
        { name: 'Jeika', value: 'Jeika' },
        { name: 'Tugce', value: 'Tugce' },
        { name: 'Sandro', value: 'Sandro' },
        { name: 'Michael', value: 'Michael' },
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' }
      )
  );

const clearEntryCommand = new SlashCommandBuilder()
  .setName('clearentry')
  .setDescription("Clear a specific student's queue entry for a coach (today)")
  .addStringOption((opt) =>
    opt
      .setName('coach')
      .setDescription('Coach name')
      .setRequired(true)
      .addChoices(
        { name: 'Jeika', value: 'Jeika' },
        { name: 'Tugce', value: 'Tugce' },
        { name: 'Sandro', value: 'Sandro' },
        { name: 'Michael', value: 'Michael' },
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' }
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
      .setDescription('Coach name')
      .setRequired(true)
      .addChoices(
        { name: 'Jeika', value: 'Jeika' },
        { name: 'Tugce', value: 'Tugce' },
        { name: 'Sandro', value: 'Sandro' },
        { name: 'Michael', value: 'Michael' },
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' }
      )
  )
  .addBooleanOption((opt) =>
    opt
      .setName('confirm')
      .setDescription('You must set this to true to confirm clearing everything for that coach')
      .setRequired(true)
  );

const toggleQueueCommand = new SlashCommandBuilder()
  .setName('togglequeue')
  .setDescription('Toggle your own queueing automation on/off');

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ---- Role check helper ----
async function memberHasRequiredRole(interaction) {
  if (!REQUIRED_ROLE_ID) return false;
  let member = interaction.member;
  if (!member || !member.roles || !member.roles.cache) {
    try {
      if (interaction.guild) {
        member = await interaction.guild.members.fetch(interaction.user.id);
      }
    } catch {
      return false;
    }
  }
  if (!member || !member.roles) return false;
  return member.roles.cache.has(REQUIRED_ROLE_ID);
}

// ---- Safe reply ----
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(options);
    } else {
      await interaction.reply(options);
    }
  } catch (e) {
    console.warn('⚠️ safeReply failure:', e.message || e);
  }
}

// ---- Ready & register ----
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [
        queueCommand.toJSON(),
        clearEntryCommand.toJSON(),
        clearAllCommand.toJSON(),
        toggleQueueCommand.toJSON(),
      ],
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

  if (!(await memberHasRequiredRole(interaction))) {
    await safeReply(interaction, {
      content: `❌ You need the Team Ambitious Labs role to use this command.`,
      flags: 64,
    });
    return;
  }

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');
    if (!queueTable) {
      await safeReply(interaction, {
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
      return;
    }
    try {
      await interaction.deferReply({ flags: 64 });
      await buildAndSendSummaryForCoach(coach);
      await safeReply(interaction, {
        content: `✅ Summary for **${coach}** sent.`,
        flags: 64,
      });
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      await safeReply(interaction, {
        content: 'There was an error fetching the queue.',
        flags: 64,
      });
    }
  } else if (interaction.commandName === 'clearentry') {
    const coach = interaction.options.getString('coach');
    const student = interaction.options.getString('student');
    const callerId = interaction.user.id;

    if (coachDiscordIds[coach] !== callerId) {
      await safeReply(interaction, {
        content: `❌ You are not authorized to clear entries for ${coach}.`,
        flags: 64,
      });
      return;
    }

    if (!queueTable) {
      await safeReply(interaction, {
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
      return;
    }

    try {
      await interaction.deferReply({ flags: 64 });

      const records = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${coach}", {User} = "${student}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
        })
        .all();

      if (records.length === 0) {
        await safeReply(interaction, {
          content: `ℹ️ No queue entries found for **${student}** under **${coach}** today.`,
        });
        return;
      }

      const ids = records.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 10) {
        await queueTable.destroy(ids.slice(i, i + 10));
      }

      await safeReply(interaction, {
        content: `🗑️ Cleared ${records.length} entr${
          records.length === 1 ? 'y' : 'ies'
        } for **${student}** under **${coach}** today.`,
      });
    } catch (err) {
      console.error('❌ Error clearing entry:', err);
      await safeReply(interaction, {
        content: 'Failed to clear the queue entry.',
        flags: 64,
      });
    }
  } else if (interaction.commandName === 'clearall') {
    const coach = interaction.options.getString('coach');
    const confirm = interaction.options.getBoolean('confirm');
    const callerId = interaction.user.id;

    if (coachDiscordIds[coach] !== callerId) {
      await safeReply(interaction, {
        content: `❌ You are not authorized to clear entries for ${coach}.`,
        flags: 64,
      });
      return;
    }

    if (!confirm) {
      await safeReply(interaction, {
        content: `⚠️ This will remove *all* queue entries for **${coach}** (including prior days). If you’re sure, re-run with \`confirm: true\`.`,
        flags: 64,
      });
      return;
    }

    if (!queueTable) {
      await safeReply(interaction, {
        content: '⚠️ Queue table not configured properly.',
        flags: 64,
      });
      return;
    }

    try {
      await interaction.deferReply({ flags: 64 });

      const records = await queueTable
        .select({
          filterByFormula: `{Mentioned} = "${coach}"`,
          maxRecords: 1000,
        })
        .all();

      if (records.length === 0) {
        await safeReply(interaction, {
          content: `ℹ️ No queue entries to clear for **${coach}**.`,
        });
        return;
      }

      const ids = records.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 10) {
        await queueTable.destroy(ids.slice(i, i + 10));
      }

      await safeReply(interaction, {
        content: `🗑️ Cleared all (${records.length}) queue entr${
          records.length === 1 ? 'y' : 'ies'
        } for **${coach}** (all dates).`,
      });
    } catch (err) {
      console.error('❌ Error clearing all entries:', err);
      await safeReply(interaction, {
        content: 'Failed to clear the queue.',
        flags: 64,
      });
    }
  } else if (interaction.commandName === 'togglequeue') {
    const byId = Object.entries(coachDiscordIds).find(
      ([_, id]) => id === interaction.user.id
    );
    if (!byId) {
      await safeReply(interaction, {
        content: `❌ Only a coach can toggle their own queueing state.`,
        flags: 64,
      });
      return;
    }
    const coachName = byId[0];
    queueEnabled[coachName] = !queueEnabled[coachName];
    const status = queueEnabled[coachName] ? 'ENABLED' : 'DISABLED';
    await safeReply(interaction, {
      content: `✅ Your queueing automation is now **${status}**.`,
      flags: 64,
    });
    try {
      const summaryChannel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
      if (summaryChannel?.isTextBased?.()) {
        await summaryChannel.send(
          `<@${coachDiscordIds[coachName]}> has **${status}** their queueing automation.`
        );
      }
    } catch (e) {
      console.warn('Failed to log toggle to summary channel:', e);
    }
  }
});

// ---- Mention / queue logic ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) return;

  const nowEST = getESTNow();
  const inOffice = isWithinCoachHours(mentionedCoach, nowEST);
  const weekend = isWeekendEST(nowEST);
  const nextAvail = getNextAvailability(mentionedCoach, nowEST);
  const username = message.author.username;

  const friendlyMessage = `Thank you for your message! Coach ${mentionedCoach} is currently out of office and will be back at ${nextAvail} EST. Don’t worry—I’ll make sure you’re on their radar when they return.`;

  try {
    if (weekend || !inOffice || !queueEnabled[mentionedCoach]) {
      const today = todayDateEST();
      const filter = `AND({Mentioned} = "${mentionedCoach}", {User} = "${username}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`;
      let existing = [];
      if (queueTable) {
        existing = await queueTable
          .select({ filterByFormula: filter, maxRecords: 1 })
          .firstPage();
      }

      if (queueTable) {
        if (existing.length === 0) {
          await queueTable.create({
            User: username,
            Mentioned: mentionedCoach,
            Timestamp: nowEST.toISOString(),
            Message: message.content,
            Channel: message.channel?.name || 'Unknown',
          });
          console.log(
            `📥 New queue entry for ${username} -> ${mentionedCoach} (OOO/disabled)`
          );
        } else {
          const existingRecord = existing[0];
          const prevMsg = existingRecord.get('Message') || '';
          const updated = prevMsg
            ? `${prevMsg}\n- ${message.content}`
            : message.content;
          await queueTable.update(existingRecord.id, {
            Message: updated,
            Channel: message.channel?.name || 'Unknown',
          });
          console.log(
            `📝 Appended to existing queue entry for ${username} -> ${mentionedCoach} (OOO/disabled)`
          );
        }
      } else {
        console.warn('Airtable not configured; cannot queue.');
      }

      const todayStr = todayDateEST();
      if (friendlyReplied[mentionedCoach][username] !== todayStr) {
        await message.reply(friendlyMessage);
        friendlyReplied[mentionedCoach][username] = todayStr;
        console.log(
          `Replied out-of-office to ${username} for ${mentionedCoach}`
        );
      } else {
        console.log(
          `Skipped duplicate friendly reply to ${username} for ${mentionedCoach}`
        );
      }
    } else {
      // in-office & queue enabled: do nothing but log
      console.log(
        `Mention during in-office for ${mentionedCoach} by ${username}; not queued.`
      );
    }
  } catch (err) {
    console.error('❌ Error handling mention:', err);
  }
});

// ---- Daily summary at 8:00 AM EST ----
cron.schedule(
  '0 8 * * *',
  async () => {
    const today = todayDateEST();
    if (!queueTable) return;

    console.log('🕗 Running daily summary job for', today);
    try {
      for (const coach of Object.keys(coachDiscordIds)) {
        await buildAndSendSummaryForCoach(coach);
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
