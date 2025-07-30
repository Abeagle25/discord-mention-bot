require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Airtable = require('airtable');
const express = require('express');
const axios = require('axios');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Airtable config
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Users to monitor
const monitoredUsers = [
  {
    id: '852485920023117854', // Jeika
    name: 'Jeika',
    startHour: 3,
    endHour: 4
  },
  {
    id: '454775533671284746', // Tugce
    name: 'Tugce',
    startHour: 3,
    endHour: 4
  }
];

// Message monitoring logic
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const now = new Date();
  const currentHour = now.getHours();

  for (const user of monitoredUsers) {
    const isMentioned = message.mentions.users.has(user.id);
    const isWithinHours = currentHour >= user.startHour && currentHour < user.endHour;

    console.log(`[CHECK] Mentioned: ${isMentioned}, Within Hours: ${isWithinHours} (${user.name})`);

    if (isMentioned && !isWithinHours) {
      try {
        await base(process.env.AIRTABLE_TABLE_NAME).create({
          "Mentioned": user.name,
          "User": message.author.username,
          "Message": message.content,
          "Timestamp": new Date().toISOString(),
          "Channel": message.channel.name || "DM or Unknown"
        });
        console.log(`📥 Queued mention for ${user.name} from ${message.author.username}`);

        await message.reply({
          content: `Heads up! ${user.name} is currently out of office. We'll make sure they see this when they're back. 😊`
        });
        console.log(`💬 Sent OOO reply for ${user.name}`);
      } catch (err) {
        console.error('❌ Error handling message:', err);
      }
    }
  }
});

// Discord Ready
client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);

  // Start Express server after bot is ready
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get('/', (req, res) => {
    res.send('Bot is running!');
  });

  app.listen(PORT, () => {
    console.log(`🌐 Express server running on port ${PORT}`);
  });

  // Uptime ping every 4 minutes
  setInterval(() => {
    const url = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL}`;
    if (url) {
      axios.get(url)
        .then(() => console.log('🔁 Self-ping successful'))
        .catch((err) => console.error('❌ Self-ping failed:', err.message));
    } else {
      console.warn('⚠️ SELF_PING_URL not set in .env');
    }
  }, 240000); // 4 minutes
});

// Login with error handling
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login to Discord:', err);
  process.exit(1); // Stop app if login fails
});
