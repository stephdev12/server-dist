'use strict';

/**
 * Format text with fancy font
 * @param {string} text - Text to format
 * @returns {string} Formatted text
 */
function formatText(text) {
    const normalChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const fancyChars = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ';
    
    return text.split('').map(char => {
        const index = normalChars.indexOf(char);
        return index !== -1 ? fancyChars[index] : char;
    }).join('');
}

/**
 * Translate text if translation config is provided
 * @param {string} text - Text to translate
 * @param {Object} options - Translation options
 * @returns {string} Translated or original text
 */
function translateIfNeeded(text, options = {}) {
    const { phoneNumber, userConfigManager, translationKey, translationVars } = options;
    
    if (translationKey && phoneNumber && userConfigManager && typeof userConfigManager.translate === 'function') {
        return userConfigManager.translate(phoneNumber, translationKey, translationVars);
    }
    
    return text;
}

// Corrected module exports
module.exports = {
    formatText,
    translateIfNeeded
};
