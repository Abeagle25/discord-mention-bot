require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Airtable = require('airtable');
const express = require('express');
const axios = require('axios');

// Create Discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Monitored users and their working hours
const monitoredUsers = [
  {
    id: '852485920023117854', // Jeika
    name: 'Jeika',
    startHour: 3, // 3 AM
    endHour: 4   // 10 PM
  },
  {
    id: '454775533671284746', // Tugce
    name: 'Tugce',
    startHour: 3,
    endHour: 4
  }
];

// Event listener for mentions
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
        // Save to Airtable
        await base(process.env.AIRTABLE_TABLE_NAME).create({
          "Mentioned": user.name,
          "User": message.author.username,
          "Message": message.content,
          "Timestamp": now.toISOString(),
          "Channel": message.channel.name || "DM or Unknown"
        });
        console.log(`📥 Queued mention for ${user.name} from ${message.author.username}`);

        // Out-of-office reply
        await message.reply({
          content: `👋 Heads up! ${user.name} is currently out of office. We'll make sure they see this when they're back.`
        });
        console.log(`💬 Sent OOO reply for ${user.name}`);
      } catch (err) {
        console.error('❌ Error saving to Airtable or replying:', err);
      }
    }
  }
});

// Start bot and server after ready
client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);

  // Start Express server
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get('/', (req, res) => {
    res.send('Bot is running!');
  });

  app.listen(PORT, () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`🚀 App accessible at https://${process.env.RENDER_EXTERNAL_URL}`);
  });

  // Keep Render alive
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

// Login
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login to Discord:', err);
  process.exit(1);
});
