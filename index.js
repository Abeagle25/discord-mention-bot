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
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID; // e.g., Team Ambitious Labs role ID
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
  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(
    AIRTABLE_BASE_ID
  );
  queueTable = base(AIRTABLE_TABLE_NAME);
} else {
  console.warn(
    '⚠️ Airtable configuration incomplete; queue will not work properly.'
  );
}

// ---- Coaches config ----
// Each coach can have multiple availability windows per day (EST)
const coachHours = {
  Jeika: [{ start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } }], // 10AM–3PM EST
  Tugce: [{ start: { hour: 8, minute: 0 }, end: { hour: 18, minute: 0 } }], // 8AM–6PM
  Sandro: [{ start: { hour: 6, minute: 0 }, end: { hour: 16, minute: 0 } }], // 6AM–4PM
  Michael: [
    { start: { hour: 9, minute: 0 }, end: { hour: 13, minute: 0 } }, // 9AM–1PM
    { start: { hour: 20, minute: 0 }, end: { hour: 24, minute: 0 } }, // 8PM–12AM
  ],
  Divine: [{ start: { hour: 8, minute: 0 }, end: { hour: 17, minute: 0 } }], // 8AM–5PM
  Phil: [{ start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } }], // 8AM–4PM
};
// Discord IDs for tagging / authorization
const coachDiscordIds = {
  Jeika: '852485920023117854',
  Tugce: '454775533671284746',
  Sandro: '814382156633079828',
  Michael: '673171818437279755',
  Divine: '692545355849400320',
  Phil: '1058164184292016148',
};

// ---- Queue toggle state per coach (true = enabled) ----
const coachQueueEnabled = {
  Jeika: true,
  Tugce: true,
  Sandro: true,
  Michael: true,
  Divine: true,
  Phil: true,
};

// ---- Reminder / reply tracking ----
const reminderSent = {}; // { coachName: 'YYYY-MM-DD' }
const lastUserReply = {}; // { coachName: { username: 'YYYY-MM-DD' } } to limit one out-of-office reply per day

// ---- Deduplication for messageCreate processing ----
const processingMessages = new Set();

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
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/New_York',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
function toMinutes(t) {
  return t.hour * 60 + (t.minute || 0);
}
function isWithinCoachHours(coach, estDate) {
  const nowMin = estDate.getHours() * 60 + estDate.getMinutes();
  const windows = coachHours[coach] || [];
  for (const { start, end } of windows) {
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    if (nowMin >= startMin && nowMin < endMin) return true;
  }
  return false;
}
function isWeekend(estDate) {
  const d = estDate.getDay(); // 0 Sunday,6 Saturday
  return d === 0 || d === 6;
}
function addDaysSkippingWeekend(date, days) {
  const copy = new Date(date);
  let added = 0;
  while (added < days) {
    copy.setDate(copy.getDate() + 1);
    const dow = copy.getDay();
    if (dow === 0 || dow === 6) continue;
    added += 1;
  }
  return copy;
}
function getNextAvailability(coach, estDate) {
  // if today is weekend, find next Monday (or next weekday) and first window
  const windows = coachHours[coach] || [];
  const todayDow = estDate.getDay(); // 0 Sunday
  // Helper to get after current time in today's windows
  const nowMinutes = estDate.getHours() * 60 + estDate.getMinutes();

  if (!isWeekend(estDate)) {
    for (const { start, end } of windows) {
      const startMin = toMinutes(start);
      const endMin = toMinutes(end);
      if (nowMinutes < startMin) {
        // later today at start
        const next = new Date(estDate);
        next.setHours(start.hour);
        next.setMinutes(start.minute || 0);
        next.setSeconds(0);
        return next;
      }
    }
  }

  // Otherwise find next workday (skip Sat/Sun)
  let candidate = new Date(estDate);
  do {
    candidate.setDate(candidate.getDate() + 1);
  } while (candidate.getDay() === 0 || candidate.getDay() === 6);

  // pick first window of that day
  if ((coachHours[coach] || []).length > 0) {
    const firstWindow = coachHours[coach][0];
    candidate.setHours(firstWindow.start.hour);
    candidate.setMinutes(firstWindow.start.minute || 0);
    candidate.setSeconds(0);
    return candidate;
  }

  // fallback to next day at 09:00
  candidate.setHours(9);
  candidate.setMinutes(0);
  candidate.setSeconds(0);
  return candidate;
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
    const channelList = [...info.channels]
      .map((c) => `#${c}`)
      .join(', ');
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

app.listen(PORT, () =>
  console.log(`🌐 HTTP server listening on port ${PORT}`)
);

// ---- Self-ping to stay awake ----
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
}, 180000); // every 3 minutes

// ---- Discord client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // needed for role checks
  ],
});

// Logging
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));

// ---- Slash commands setup ----
const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription(
    "View who's in the queue for a coach (with per-student summary)"
  )
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
  .setDescription(
    "Clear a specific student's queue entry for a coach (today)"
  )
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
  .setDescription(
    "Clear the entire queue for a coach (all dates, requires confirmation)"
  )
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
      .setDescription(
        'You must set this to true to confirm clearing everything for that coach'
      )
      .setRequired(true)
  );

const toggleQueueCommand = new SlashCommandBuilder()
  .setName('togglequeue')
  .setDescription('Enable or disable your queueing automation')
  .addStringOption((opt) =>
    opt
      .setName('state')
      .setDescription('on or off')
      .setRequired(true)
      .addChoices(
        { name: 'on', value: 'on' },
        { name: 'off', value: 'off' }
      )
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
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      {
        body: [
          queueCommand.toJSON(),
          clearEntryCommand.toJSON(),
          clearAllCommand.toJSON(),
          toggleQueueCommand.toJSON(),
        ],
      }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// ---- Interaction handler ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const today = todayDateEST();

  // role gating for management commands (except toggle which is per coach)
  if (
    interaction.commandName !== 'togglequeue' &&
    !(await memberHasRequiredRole(interaction))
  ) {
    await safeReply(interaction, {
      content: `❌ You need the Team Ambitious Labs role to use this command.`,
      flags: 64,
    });
    return;
  }

  if (interaction.commandName === 'queue') {
    const coach = interaction.options.getString('coach');
    try {
      if (!queueTable) {
        await interaction.reply({
          content: '⚠️ Queue table not configured properly.',
          flags: 64,
        });
        return;
      }
      await interaction.deferReply({ flags: 64 });
      await buildAndSendSummaryForCoach(coach);
      await safeReply(interaction, {
        content: `✅ Summary for **${coach}** sent.`,
        flags: 64,
      });
    } catch (err) {
      console.error('❌ Error fetching queue:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'There was an error fetching the queue.',
        });
      } else {
        await interaction.reply({
          content: 'There was an error fetching the queue.',
          flags: 64,
        });
      }
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
    // only the coach themself can toggle their own
    const state = interaction.options.getString('state'); // 'on' or 'off'
    const userId = interaction.user.id;
    const coachEntry = Object.entries(coachDiscordIds).find(
      ([name, id]) => id === userId
    );
    if (!coachEntry) {
      await safeReply(interaction, {
        content: `❌ Only a recognized coach can toggle their own queueing.`,
        flags: 64,
      });
      return;
    }
    const coach = coachEntry[0];
    const enable = state === 'on';
    coachQueueEnabled[coach] = enable;

    // log in summary channel
    const summaryChannel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    const statusText = enable ? 'enabled' : 'disabled';
    const availability = getNextAvailability(coach, getESTNow());
    const availStr = formatEST(availability.toISOString());
    if (summaryChannel?.isTextBased?.()) {
      await summaryChannel.send(
        `🔁 Queueing for **${coach}** was **${statusText}** by <@${coachDiscordIds[coach]}>. Next expected availability: ${availStr} EST.`
      );
    }

    await safeReply(interaction, {
      content: `✅ Your queueing automation is now **${statusText}**. Next expected availability: ${availStr} EST.`,
    });
  }
});

// ---- Mention / queue logic (with office-hour log, EST handling, toggles, and rate-limited out-of-office replies) ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // dedupe concurrent processing
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  setTimeout(() => processingMessages.delete(message.id), 2 * 60 * 1000); // cleanup after 2 min

  console.log(`[MSG] ${message.author.username}: ${message.content}`);

  const mentionedCoach = Object.keys(coachDiscordIds).find((coach) =>
    message.mentions.users.has(coachDiscordIds[coach])
  );
  if (!mentionedCoach) return;

  const nowEST = getESTNow();
  const isInHours = isWithinCoachHours(mentionedCoach, nowEST);
  console.log(
    `[CHECK] Mentioned coach=${mentionedCoach}, EST time=${nowEST.getHours()}:${nowEST
      .getMinutes()
      .toString()
      .padStart(2, '0')}, in hours=${isInHours}, queueEnabled=${coachQueueEnabled[mentionedCoach]}`
  );

  // If within scheduled working hours: do nothing except log.
  if (isInHours) {
    console.log(
      `[INFO] Mention of ${message.author.username} for ${mentionedCoach} during their work hours. (No queueing or reply as per current config)`
    );
    return;
  }

  // Outside hours or queue disabled path
  const username = message.author.username;

  // limit one out-of-office reply per (coach, user) per day
  lastUserReply[mentionedCoach] = lastUserReply[mentionedCoach] || {};
  if (lastUserReply[mentionedCoach][username] === todayDateEST()) {
    // already replied today; possibly still queue if enabled
  }

  const nextAvailDate = getNextAvailability(mentionedCoach, nowEST);
  let backAtStr = '';
  // if it's weekend and next availability is Monday give "Monday at HH:MM"
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const isSameDay =
    nextAvailDate.toDateString() === nowEST.toDateString();
  if (isSameDay) {
    backAtStr = formatEST(nextAvailDate.toISOString());
  } else {
    backAtStr = `${dayNames[nextAvailDate.getDay()]} at ${formatEST(
      nextAvailDate.toISOString()
    )}`;
  }

  // Friendly message (always same) when coach is out of office or queueing disabled
  const replyMessage = `Thank you for your message! Coach ${mentionedCoach} is currently out of office and will be back at ${backAtStr} EST. Don’t worry—I’ll make sure you’re on their radar when they return.`;

  // Send reply only once per day per coach-user
  if (lastUserReply[mentionedCoach][username] !== todayDateEST()) {
    try {
      await message.reply({
        content: replyMessage,
      });
      lastUserReply[mentionedCoach][username] = todayDateEST();
    } catch (err) {
      console.warn('Failed to send out-of-office reply:', err.message);
    }
  }

  // If queueing is enabled for that coach, and it's outside their hours, add to queue
  if (coachQueueEnabled[mentionedCoach]) {
    if (!queueTable) {
      console.warn('Airtable not configured; cannot queue.');
      return;
    }

    const today = todayDateEST();

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

      // log position (optional)
      const allRecords = await queueTable
        .select({
          filterByFormula: `AND({Mentioned} = "${mentionedCoach}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`,
          sort: [{ field: 'Timestamp', direction: 'asc' }],
        })
        .all();
      const uniqueUsers = [
        ...new Set(allRecords.map((r) => r.get('User'))),
      ];
      const position = uniqueUsers.indexOf(username) + 1;
      console.log(
        `Queued: ${username} for ${mentionedCoach} (#${position})`
      );
    } catch (err) {
      console.error('❌ Error handling mention / queue insertion:', err);
    }
  } else {
    // queue disabled: nothing else to do except already replied
    console.log(
      `[INFO] Queueing disabled for ${mentionedCoach}; mention from ${username} noted but not queued.`
    );
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
