require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const Airtable = require('airtable');
const express = require('express');
const axios = require('axios');

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Monitored users
const monitoredUsers = [
  {
    id: '852485920023117854', // Jeika
    name: 'Jeika',
    startHour: 3,
    endHour: 22
  },
  {
    id: '454775533671284746', // Tugce
    name: 'Tugce',
    startHour: 3,
    endHour: 22
  }
];

// When bot is ready
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  startDailySummaryJob(); // Daily summary cron
});

// On message
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const now = new Date();
  const currentHour = now.getHours();
  const today = now.toISOString().split('T')[0]; // yyyy-mm-dd

  monitoredUsers.forEach(async (user) => {
    const isMentioned = message.mentions.users.has(user.id);
    const isWithinHours = currentHour >= user.startHour && currentHour < user.endHour;

    console.log(`[CHECK] Mentioned: ${isMentioned}, Within Hours: ${isWithinHours} (${user.name})`);

    if (isMentioned && !isWithinHours) {
      try {
        // Check existing same-day entry
        const records = await base(process.env.AIRTABLE_TABLE_NAME)
          .select({
            filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today"}"))`
          })
          .all();

        let queuePosition;
        if (records.length > 0) {
          // Append message to existing record
          const record = records[0];
          const existingMessages = record.fields.Messages || '';
          const newMessages = `${existingMessages}\n[${message.author.username}] ${message.content}`;
          await base(process.env.AIRTABLE_TABLE_NAME).update(record.id, {
            "Messages": newMessages
          });
          queuePosition = 'Already queued today.';
        } else {
          // New entry
          await base(process.env.AIRTABLE_TABLE_NAME).create({
            "Mentioned": user.name,
            "User": message.author.username,
            "Messages": `[${message.author.username}] ${message.content}`,
            "Timestamp": now.toISOString(),
            "Channel": message.channel.name || "DM or Unknown"
          });
          queuePosition = 'You’re the first to mention them today!';
        }

        console.log(`📥 Queued mention for ${user.name} from ${message.author.username}`);

        await message.reply({
          content: `Heads up! ${user.name} is currently out of office.\n${queuePosition} We'll make sure they see this when they're back. 😊`
        });
        console.log(`💬 Sent OOO reply for ${user.name}`);
      } catch (err) {
        console.error('❌ Airtable error or message failure:', err);
      }
    }
  });
});

// Daily summary job
function startDailySummaryJob() {
  const now = new Date();
  const millisTill10PM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0, 0) - now;
  setTimeout(() => {
    sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000); // Every 24 hours
  }, millisTill10PM);
}

async function sendDailySummary() {
  const today = new Date().toISOString().split('T')[0];
  const summaryChannel = await client.channels.fetch(process.env.SUMMARY_CHANNEL_ID);

  if (!summaryChannel || summaryChannel.type !== ChannelType.GuildText) {
    console.warn('⚠️ Invalid summary channel ID or type.');
    return;
  }

  let summary = `📋 **Daily Mention Summary** (${today})\n`;

  for (const user of monitoredUsers) {
    const records = await base(process.env.AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`
      })
      .all();

    if (records.length > 0) {
      const entry = records[0].fields;
      summary += `\n**${user.name}** was mentioned by **${entry.User}**:\n${entry.Messages}\n`;
    } else {
      summary += `\n**${user.name}** had no mentions today.\n`;
    }
  }

  await summaryChannel.send(summary);
  console.log('📨 Daily summary sent.');
}

// Express for uptime
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Self-ping every 4 minutes
setInterval(() => {
  const url = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL}`;
  if (url) {
    axios.get(url)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) => console.error('❌ Self-ping failed:', err.message));
  } else {
    console.warn('⚠️ SELF_PING_URL not set');
  }
}, 240000);
