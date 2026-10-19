require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,

  adminPassword: process.env.ADMIN_PASSWORD,

  tgToken: process.env.TELEGRAM_BOT_TOKEN,

  tgAdmin: process.env.TELEGRAM_ADMIN_ID,

  ipSalt: process.env.IP_SALT,

  dbPath: './data/hunter.db',

  quizSeconds: 15
};
