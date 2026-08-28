// ⚙️ REN-MDX - CONFIGURATION (Via .env)
require('dotenv').config();

module.exports = {
  // --- IDENTITÉ ---
  botName: process.env.BOT_NAME || 'REN-MDX',
  ownerName: process.env.OWNER_NAME || 'Admin',
  ownerNumber: (process.env.OWNER_NUMBER || '237650471093').split(','), // Support multi-owner via virgule
  phoneNumber: process.env.OWNER_NUMBER || '237650471093', // Pour pairing code
  prefix: process.env.PREFIX || '.',

  // --- PARAMÈTRES INTERNES ---
  sessionName: process.env.SESSION_NAME || 'session',
  defaultLang: process.env.DEFAULT_LANG || 'fr',
  autoRead: process.env.AUTO_READ === 'true',
  
  // --- NEWSLETTER & LINKS ---
  newsletterJid: process.env.NEWSLETTER_JID || '120363420601379038@newsletter',
  logoUrl: process.env.LOGO_URL || 'https://i.postimg.cc/8cKZBMZw/lv-0-20251105211949.jpg',

  // --- OPTIMISATIONS ---
  syncFullHistory: false, 
  keepAliveInterval: 30000, 

  // --- BASE DE DONNÉES (JSON) ---
  database: {
    users: './database/users.json',
    groups: './database/groups.json',
    settings: './database/settings.json'
  }
};