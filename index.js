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
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
const PORT = process.env.PORT || 3000;
const SELF_PING_URL =
  process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL || ''}`;

// ---- Debug / sanity ----
console.log(`PID ${process.pid} starting up`);
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
  console.warn('⚠️ Airtable configuration incomplete; queue will not work.');
}

// ---- Coaches config ----
// Active windows per coach in ET
const coachHours = {
  Jeika: [{ start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } }], // 10AM–3PM
  Tugce: [{ start: { hour: 8, minute: 0 }, end: { hour: 18, minute: 0 } }], // 8AM–6PM
  Sandro: [{ start: { hour: 6, minute: 0 }, end: { hour: 16, minute: 0 } }], // 6AM–4PM
  Divine: [{ start: { hour: 8, minute: 0 }, end: { hour: 17, minute: 0 } }], // 8AM–5PM
  Phil: [{ start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } }], // 8AM–4PM
  Michael: [
    { start: { hour: 9, minute: 0 }, end: { hour: 13, minute: 0 } }, // 9AM-1PM
    { start: { hour: 20, minute: 0 }, end: { hour: 0, minute: 0 } }, // 8PM-midnight
  ],
};
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
  Sandro: '814382156633079828',
  Divine: '692545355849400320',
  Phil: '1058164184292016148',
  Michael: '673171818437279755',
};

// ---- Reminder tracking ----
const reminderSent = {}; // per coach per day

// ---- Deduplication sets ----
const processingMessages = new Set();
const repliedToday = new Map(); // key `${coach}-${userId}-${date}`

// ---- Time helpers (ET) ----
function getETParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const extract = {};
  for (const p of parts) {
    if (p.type === 'year') extract.year = parseInt(p.value, 10);
    if (p.type === 'month') extract.month = parseInt(p.value, 10);
    if (p.type === 'day') extract.day = parseInt(p.value, 10);
    if (p.type === 'hour') extract.hour = parseInt(p.value, 10);
    if (p.type === 'minute') extract.minute = parseInt(p.value, 10);
    if (p.type === 'weekday') extract.weekday = p.value; // e.g., "Mon"
  }
  return extract;
}
function isWeekendET(date = new Date()) {
  const etParts = getETParts(date);
  return etParts.weekday === 'Sat' || etParts.weekday === 'Sun';
}
function formatETTimeFromParts({ hour, minute }) {
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const mm = String(minute).padStart(2, '0');
  return `${h12}:${mm} ${ampm}`;
}
function humanReadableNextAvailability(coach, fromDate = new Date()) {
  const etNow = getETParts(fromDate);
  const todayWeekday = etNow.weekday; // e.g., "Fri"
  const schedule = coachHours[coach];
  const nowMinutes = etNow.hour * 60 + etNow.minute;

  function minutes(t) {
    return t.hour * 60 + (t.minute || 0);
  }

  // Weekend -> next Monday first window
  if (todayWeekday === 'Sat' || todayWeekday === 'Sun') {
    const nextWindow = schedule[0];
    const timeStr = formatETTimeFromParts(nextWindow.start);
    return `Monday at ${timeStr}`;
  }

  // Before any window today
  for (const win of schedule) {
    const startMin = minutes(win.start);
    if (nowMinutes < startMin) {
      const timeStr = formatETTimeFromParts(win.start);
      return `${timeStr}`;
    }
  }

  // After today's windows: find next weekday with schedule (skip weekend)
  const weekdayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let currentIndex = weekdayOrder.indexOf(todayWeekday);
  let nextDayName = '';
  for (let i = 1; i <= 7; i++) {
    const candidateIdx = (currentIndex + i) % 7;
    const candidateWeekday = weekdayOrder[candidateIdx];
    if (candidateWeekday === 'Sat' || candidateWeekday === 'Sun') continue;
    nextDayName = candidateWeekday;
    break;
  }
  const prettyDay = {
    Sun: 'Sunday',
    Mon: 'Monday',
    Tue: 'Tuesday',
    Wed: 'Wednesday',
    Thu: 'Thursday',
    Fri: 'Friday',
    Sat: 'Saturday',
  }[nextDayName || 'Monday'];
  const nextWindow = schedule[0];
  const timeStr = formatETTimeFromParts(nextWindow.start);
  return `${prettyDay} at ${timeStr}`;
}

function coachIsActiveNow(coach, date = new Date()) {
  if (isWeekendET(date)) return false;
  const etParts = getETParts(date);
  const nowMinutes = etParts.hour * 60 + etParts.minute;
  const schedule = coachHours[coach];
  for (const win of schedule) {
    let startMin = win.start.hour * 60 + (win.start.minute || 0);
    let endMin = win.end.hour * 60 + (win.end.minute || 0);
    if (endMin === 0) endMin = 24 * 60;
    if (nowMinutes >= startMin && nowMinutes < endMin) {
      return true;
    }
  }
  return false;
}
function todayDateEST() {
  const et = getETParts();
  const mm = String(et.month).padStart(2, '0');
  const dd = String(et.day).padStart(2, '0');
  return `${et.year}-${mm}-${dd}`;
}
function formatEST(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

// ---- Express for health / manual summary ----
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
  if (!queueTable) return res.status(500).send('Queue table not configured.');
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
        console.error('❌ Self-ping failed:', err.message)
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
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' },
        { name: 'Michael', value: 'Michael' }
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
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' },
        { name: 'Michael', value: 'Michael' }
      )
  )
  .addStringOption((opt) =>
    opt.setName('student').setDescription('Student username to remove from queue').setRequired(true)
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
        { name: 'Divine', value: 'Divine' },
        { name: 'Phil', value: 'Phil' },
        { name: 'Michael', value: 'Michael' }
      )
  )
  .addBooleanOption((opt) =>
    opt
      .setName('confirm')
      .setDescription('You must set this to true to confirm clearing everything for that coach')
      .setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ---- Role gating helper ----
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

async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(options);
    } else {
      await interaction.reply(options);
    }
  } catch (e) {
    console.warn('⚠️ safeReply failure:', e.message);
  }
}

// ---- Ready & register commands ----
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
  try {
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

  if (!(await memberHasRequiredRole(interaction))) {
    await safeReply(interaction, {
      content: `❌ You need the required role to use this command.`,
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
      await interaction.editReply({
        content: `✅ Summary for **${coach}** sent.`,
        flags: 64,
      });
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      await interaction.editReply({
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
      await safeReply(interaction, {
        content: 'Failed to clear the queue.',
        flags: 64,
      });
    }
  }
});

// ---- Mention / queuing logic ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  setTimeout(() => processingMessages.delete(message.id), 2 * 60 * 1000); // cleanup

  console.log(`[MSG] ${message.author.username}: ${message.content}`);

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) return;

  const todayKey = `${mentionedCoach}-${message.author.id}-${todayDateEST()}`;
  if (repliedToday.has(todayKey)) return; // one friendly reply per coach-user per ET day

  const now = new Date();
  const active = coachIsActiveNow(mentionedCoach, now);
  console.log(
    `[CHECK] Mentioned coach=${mentionedCoach}, ET time=${formatEST(
      now
    )}, in-office=${active}`
  );

  // In-office hours: do nothing except log
  if (active) {
    console.log(
      `[INFO] Mention of ${message.author.username} for ${mentionedCoach} during their working hours; skipping queueing/reply.`
    );
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
      const updated = prevMsg
        ? `${prevMsg}\n- ${message.content}`
        : message.content;
      await queueTable.update(existingRecord.id, {
        Message: updated,
        Channel: message.channel?.name || 'Unknown',
      });
      console.log(
        `📝 Appended to existing queue entry for ${username} -> ${mentionedCoach}`
      );
    }

    const nextAvailStr = humanReadableNextAvailability(
      mentionedCoach,
      now
    );
    const replyMessage = `Thank you for your message! Coach ${mentionedCoach} is currently out of office and will be back at ${nextAvailStr} EST. Don’t worry—I’ll make sure you’re on their radar when they return.`;

    await message.reply({
      content: replyMessage,
      allowedMentions: { repliedUser: false },
    });
    repliedToday.set(todayKey, true);
    console.log(
      `Queued: ${username} for ${mentionedCoach}; replied with availability ${nextAvailStr} EST`
    );
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
