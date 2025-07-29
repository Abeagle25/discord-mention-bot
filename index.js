require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Airtable = require('airtable');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// List of users to monitor
const monitoredUsers = [
  {
    id: '852485920023117854', // Replace with actual Discord user ID
    name: 'Jeika',
    startHour: 3,   // 3 AM
    endHour: 4     // 10 PM
  },
  {
    id: '454775533671284746', // Another user ID
    name: 'Tugce',
    startHour: 3,   // 6 AM
    endHour: 4     // 6 PM
  }
];

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignore bots

  const now = new Date();
  const currentHour = now.getHours();

  monitoredUsers.forEach(async (user) => {
    const isMentioned = message.mentions.users.has(user.id);
    const isWithinHours = currentHour >= user.startHour && currentHour < user.endHour;

    if (isMentioned && isWithinHours) {
      try {
        await base(process.env.AIRTABLE_TABLE_NAME).create({
          "Mentioned": user.name,
          "User": message.author.username,
          "Message": message.content,
          "Timestamp": new Date().toISOString(),
          "Channel": message.channel.name
        });
        console.log(`📥 Queued mention for ${user.name} from ${message.author.username}`);
      } catch (err) {
        console.error('❌ Airtable error:', err);
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);
