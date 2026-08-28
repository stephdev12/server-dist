// 🛠️ FUNCTIONS - Utilitaires Généraux & Style

// Convertisseur de texte "Fancy" (Small Caps)
function styleText(text) {
    if (!text) return text;
    const normalChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const fancyChars = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ0123456789';
    
    return text.split('').map(char => {
        const index = normalChars.indexOf(char);
        return index !== -1 ? fancyChars[index] : char;
    }).join('');
}

// Formater la durée (Uptime)
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}j ${h}h ${m}m ${s}s`;
}

module.exports = { styleText, formatUptime };