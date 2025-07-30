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

// Login to Discord
client.login(process.env.DISCORD_TOKEN);

// Initialize Airtable
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

// When bot is ready
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

// Helper function: get today's date as YYYY-MM-DD
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// On message received
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const now = new Date();
  const currentHour = now.getHours();
  const today = getToday();

  monitoredUsers.forEach(async (user) => {
    const isMentioned = message.mentions.users.has(user.id);
    const isWithinHours = currentHour >= user.startHour && currentHour < user.endHour;

    if (isMentioned && !isWithinHours) {
      // Check if entry already exists
      const filter = `AND({Mentioned} = "${user.name}", {User} = "${message.author.username}", IS_SAME(DATETIME_FORMAT({Timestamp}, 'YYYY-MM-DD'), '${today}'))`;

      try {
        const records = await base(process.env.AIRTABLE_TABLE_NAME).select({
          filterByFormula: filter,
          sort: [{ field: 'Timestamp', direction: 'asc' }]
        }).firstPage();

        if (records.length > 0) {
          // Update existing record with additional message
          const existing = records[0];
          const currentMessage = existing.fields.Message || '';
          const updatedMessage = `${currentMessage}\n- ${message.content}`;

          await base(process.env.AIRTABLE_TABLE_NAME).update(existing.id, {
            Message: updatedMessage
          });

          console.log(`📝 Appended message for ${user.name} from ${message.author.username}`);
        } else {
          // Create new record
          await base(process.env.AIRTABLE_TABLE_NAME).create({
            Mentioned: user.name,
            User: message.author.username,
            Message: message.content,
            Timestamp: new Date().toISOString(),
            Channel: message.channel.name || "DM or Unknown"
          });

          console.log(`📥 New queue entry for ${user.name} from ${message.author.username}`);
        }

        // Get updated queue count
        const queueRecords = await base(process.env.AIRTABLE_TABLE_NAME).select({
          filterByFormula: `AND({Mentioned} = "${user.name}", IS_SAME(DATETIME_FORMAT({Timestamp}, 'YYYY-MM-DD'), '${today}'))`
        }).firstPage();

        // Get unique users in queue
        const studentUsernames = [...new Set(queueRecords.map(r => r.fields.User))];
        const position = studentUsernames.indexOf(message.author.username) + 1;

        // Send reply
        await message.reply({
          content: `Hey ${message.author.username}, your message has been added to your coach’s queue. You’re number #${position} in line. They’ll get back to you during office hours.`
        });

        console.log(`💬 Replied with position #${position} for ${message.author.username}`);

      } catch (err) {
        console.error('❌ Airtable error:', err);
      }
    }
  });
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);

// Express server for UptimeRobot
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Ping yourself every 4 minutes (UptimeRobot)
setInterval(() => {
  const url = process.env.SELF_PING_URL || `https://${process.env.RENDER_EXTERNAL_URL}`;
  if (url) {
    axios.get(url)
      .then(() => console.log('🔁 Self-ping successful'))
      .catch((err) => console.error('❌ Self-ping failed:', err.message));
  } else {
    console.warn('⚠️ SELF_PING_URL not set in .env');
  }
}, 240000);
