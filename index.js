// index.js

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const Airtable = require('airtable');
const cron = require('node-cron');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const PORT = process.env.PORT || 3000;
const OUT_OF_OFFICE_START = 3; // 3 AM
const OUT_OF_OFFICE_END = 22; // 10 PM
const CHECK_CHANNEL_ID = process.env.CHECK_CHANNEL_ID;

const usersToMonitor = [
  { id: '1234567890', name: 'Jeika' },
  { id: '0987654321', name: 'Tugce' }
];

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Util to check current hour in ET
const isWithinWorkingHours = () => {
  const now = new Date();
  const hour = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return hour >= OUT_OF_OFFICE_START && hour < OUT_OF_OFFICE_END;
};

client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  for (const user of usersToMonitor) {
    if (message.mentions.users.has(user.id)) {
      const withinHours = isWithinWorkingHours();
      console.log(`[CHECK] Mentioned: true, Within Hours: ${withinHours} (${user.name})`);

      if (!withinHours) {
        // Save to Airtable
        base('Queue').create([
          {
            fields: {
              Mentioned: user.name,
              Student: message.author.username,
              Message: message.content,
              Timestamp: new Date().toISOString()
            }
          }
        ], function (err) {
          if (err) {
            console.error('❌ Airtable error:', err);
            return;
          }
          console.log(`📥 Queued mention for ${user.name} from ${message.author.username}`);
        });

        // Count same-day queued mentions
        const today = new Date().toISOString().split("T")[0];
        base("Queue").select({
          filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`
        }).firstPage((err, records) => {
          if (err) {
            console.error("❌ Airtable count error:", err);
            return;
          }

          const position = records.length;
          message.reply(
            `Hi ${message.author}, ${user.name} is currently offline. I've queued your message. You're #${position} in line. 👀`
          );
        });
      }
    }
  }
});

// Daily summary cron job (runs at 10 PM ET)
cron.schedule('0 22 * * *', async () => {
  const today = new Date().toISOString().split("T")[0];
  const summaryMap = {};

  for (const user of usersToMonitor) {
    base("Queue").select({
      filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, "YYYY-MM-DD"), "${today}"))`
    }).firstPage((err, records) => {
      if (err) {
        console.error("❌ Daily summary error:", err);
        return;
      }

      if (records.length > 0) {
        const mentions = records.map(r => `• ${r.get("Student")}: ${r.get("Message")}`).join("\n");
        const summary = `**Daily Mention Summary for ${user.name}**\n${mentions}`;

        client.channels.fetch(CHECK_CHANNEL_ID).then(channel => {
          channel.send(summary);
        });
      }
    });
  }
}, {
  timezone: "America/New_York"
});

// Express web server to keep Render alive
const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running!');
});
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Login
client.login(DISCORD_TOKEN);
