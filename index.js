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
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID; // role gate for slash commands
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
// Active hours per coach (EST)
const coachHours = {
  Jeika: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } }, // 10AM–3PM
  Tugce: { start: { hour: 8, minute: 0 }, end: { hour: 18, minute: 0 } }, // 8AM–6PM
  Sandro: { start: { hour: 6, minute: 0 }, end: { hour: 16, minute: 0 } }, // 6AM–4PM
  Divine: { start: { hour: 8, minute: 0 }, end: { hour: 17, minute: 0 } }, // 8AM–5PM
  Phil: { start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } }, // 8AM–4PM
  Michael: [
    { start: { hour: 9, minute: 0 }, end: { hour: 13, minute: 0 } }, // 9AM-1PM
    { start: { hour: 20, minute: 0 }, end: { hour: 0, minute: 0 } }, // 8PM-12AM (midnight)
  ],
};
// Discord IDs for tagging / authorization
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
  Sandro: '814382156633079828',
  Divine: '692545355849400320',
  Phil: '1058164184292016148',
  Michael: '673171818437279755',
};

// ---- Reminder tracking ----
const reminderSent = {}; // { coachName: 'YYYY-MM-DD' }

// ---- Deduplication sets ----
const processingMessages = new Set();
const repliedToday = new Map(); // key `${coach}-${username}-${date}` to limit one reply per coach-user per day

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
// improved formatter: 12h with AM/PM
function formatEST(dateOrIso) {
  let d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}
function toMinutes(t) {
  return t.hour * 60 + (t.minute || 0);
}
function isWeekend(date) {
  const wd = date.getDay();
  return wd === 0 || wd === 6; // Sunday=0, Saturday=6
}
function coachIsActiveNow(coach, estDate) {
  const schedule = coachHours[coach];
  const nowMin = estDate.getHours() * 60 + estDate.getMinutes();
  if (Array.isArray(schedule)) {
    return schedule.some(({ start, end }) => {
      const startMin = toMinutes(start);
      let endMin = toMinutes(end);
      if (endMin === 0) endMin = 24 * 60; // handle midnight wrap
      return nowMin >= startMin && nowMin < endMin;
    });
  } else {
    const { start, end } = schedule;
    const startMin = toMinutes(start);
    let endMin = toMinutes(end);
    if (endMin === 0) endMin = 24 * 60;
    return nowMin >= startMin && nowMin < endMin;
  }
}
// next availability: if today within or before window, return the next start; if after or weekend, roll forward to next working day's first start
function getNextAvailability(coach, fromDate) {
  const d = new Date(fromDate); // EST date
  // if weekend, move to next Monday
  function advanceToNextWorkday(date) {
    const copy = new Date(date);
    while (isWeekend(copy)) {
      copy.setDate(copy.getDate() + 1);
    }
    return copy;
  }

  // get today's schedule entries normalized as array
  const schedule = Array.isArray(coachHours[coach])
    ? coachHours[coach]
    : [coachHours[coach]];

  // if weekend, jump to next workday at its first start
  if (isWeekend(d)) {
    const nextWorkday = advanceToNextWorkday(d);
    const firstStart = schedule[0].start;
    nextWorkday.setHours(firstStart.hour, firstStart.minute || 0, 0, 0);
    return nextWorkday;
  }

  // check each window for today
  const nowMin = d.getHours() * 60 + d.getMinutes();
  for (const { start, end } of schedule) {
    const startMin = toMinutes(start);
    let endMin = toMinutes(end);
    if (endMin === 0) endMin = 24 * 60;
    if (nowMin < startMin) {
      // before this window starts today
      const next = new Date(d);
      next.setHours(start.hour, start.minute || 0, 0, 0);
      return next;
    }
    if (nowMin >= startMin && nowMin < endMin) {
      // currently in window: next availability is now (shouldn't be used for out-of-office)
      return d;
    }
  }

  // after all windows today: find next day that is not weekend
  const tomorrow = new Date(d);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWorkday = advanceToNextWorkday(tomorrow);
  const firstStart = schedule[0].start;
  nextWorkday.setHours(firstStart.hour, firstStart.minute || 0, 0, 0);
  return nextWorkday;
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
  const today = todayDateEST();
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
    GatewayIntentBits.GuildMembers, // for role gating
  ],
});

// Logging
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));

// ---- Slash commands setup ----
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

// ---- Safe reply utility ----
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
    console.log('🔁 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [
        queueCommand.toJSON(),
        clearEntryCommand.toJSON(),
        clearAllCommand.toJSON(),
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

// ---- Mention / queue logic ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // dedupe processing per message
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  setTimeout(() => processingMessages.delete(message.id), 2 * 60 * 1000); // cleanup after 2m

  console.log(`[MSG] ${message.author.username}: ${message.content}`);

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) return;

  // if already replied today for this coach-user pair, skip (to avoid spam)
  const todayKey = `${mentionedCoach}-${message.author.id}-${todayDateEST()}`;
  if (repliedToday.has(todayKey)) return;

  const nowEST = getESTNow();

  console.log(
    `[CHECK] Mentioned coach=${mentionedCoach}, EST time=${formatEST(
      nowEST
    )}, active now=${coachIsActiveNow(mentionedCoach, nowEST)}`
  );

  // In-office: do nothing except log
  if (coachIsActiveNow(mentionedCoach, nowEST) && !isWeekend(nowEST)) {
    console.log(
      `[INFO] Mention of ${message.author.username} for ${mentionedCoach} during their working hours; no queueing or reply.`
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
    // upsert queue entry for out-of-office mention
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
        Timestamp: nowEST.toISOString(),
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

    // compute next availability (rolls weekends to Monday)
    const nextAvail = getNextAvailability(mentionedCoach, nowEST);
    const isSameDay =
      nextAvail.toDateString() === nowEST.toDateString() && !isWeekend(nowEST);
    let backAtStr = '';
    if (isSameDay) {
      backAtStr = `${formatEST(nextAvail)}`; // e.g., "6:00 AM"
    } else {
      const dayNames = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ];
      backAtStr = `${dayNames[nextAvail.getDay()]} at ${formatEST(
        nextAvail
      )}`; // e.g., "Monday at 6:00 AM"
    }

    const replyMessage = `Thank you for your message! Coach ${mentionedCoach} is currently out of office and will be back at ${backAtStr} EST. Don’t worry—I’ll make sure you’re on their radar when they return.`;

    await message.reply({
      content: replyMessage,
      allowedMentions: { repliedUser: false },
    });
    repliedToday.set(todayKey, true);
    console.log(
      `Queued: ${username} for ${mentionedCoach}; replied with availability ${backAtStr} EST`
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
