require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const Airtable = require('airtable');
const axios = require('axios');

// =======================
// CONFIG
// =======================

const PORT = process.env.PORT || 10000;
const WORK_START_HOUR = 3;  // 3 AM UTC
const WORK_END_HOUR = 10;   // 10 AM UTC

const MENTIONED_USERS = ['Jeika', 'Tugce'];
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

// =======================
// INIT
// =======================

const app = express();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// =======================
// UTILS
// =======================

function isWithinWorkingHours() {
  const now = new Date();
  const hour = now.getUTCHours();
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

function wasMentioned(message, user) {
  return message.mentions.users.some(mentioned => mentioned.username === user);
}

// =======================
// DISCORD EVENTS
// =======================

client.on('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  MENTIONED_USERS.forEach(async (user) => {
    const isMentioned = wasMentioned(message, user);
    const isWithinHours = isWithinWorkingHours();

    console.log(`[CHECK] Mentioned: ${isMentioned}, Within Hours: ${isWithinHours} (${user})`);

    if (isMentioned && !isWithinHours) {
      // Save to Airtable
      await base('Mentions').create([
        {
          fields: {
            Mentioned: user,
            User: message.author.username,
            Message: message.content,
            Timestamp: new Date().toISOString(),
            Channel: message.channel.name
          }
        }
      ]);

      console.log(`📥 Queued mention for ${user} from ${message.author.username}.`);

      // Reply to the user
      await message.reply(`Hi! @${user} is currently out of office. We'll make sure they see this message soon!`);
    }
  });
});

// =======================
// EXPRESS + SELF-PING
// =======================

app.get('/', (req, res) => {
  res.send('Bot is alive!');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Self-ping to keep alive (UptimeRobot)
setInterval(() => {
  axios.get(`https://discord-mention-bot.onrender.com`).then(() => {
    console.log('🔁 Self-ping successful');
  }).catch(err => {
    console.error('⚠️ Self-ping failed:', err.message);
  });
}, 5 * 60 * 1000); // every 5 minutes

// =======================
// START BOT
// =======================

client.login(DISCORD_TOKEN);
