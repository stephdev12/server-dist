'use strict';

/**
 * Steph UI - Beautiful Interactive Components for Baileys
 * @module steph-ui
 */

const { sendCarousel } = require('./lib/carousel');
const { sendButtons, sendUrlButtons, sendMixedButtons,  sendList } = require('./lib/buttons');

const { formatText, translateIfNeeded } = require('./lib/utils');

/**
 * Main StephUI class
 */
class StephUI {
    /**
     * Create a StephUI instance
     * @param {Object} sock - Baileys socket instance
     */
    constructor(sock) {
        if (!sock) {
            throw new Error('Baileys socket instance is required');
        }
        this.sock = sock;
    }

    /**
     * Send a carousel message
     * @param {string} jid - Destination JID
     * @param {Object} options - Carousel options
     * @returns {Promise<string>} Message ID
     */
    async carousel(jid, options) {
        return await sendCarousel(this.sock, jid, options);
    }

    /**
     * Send quick reply buttons
     * @param {string} jid - Destination JID
     * @param {Object} options - Button options
     * @returns {Promise<string>} Message ID
     */
    async buttons(jid, options) {
        return await sendButtons(this.sock, jid, options);
    }

    /**
     * Send URL buttons
     * @param {string} jid - Destination JID
     * @param {Object} options - Button options
     * @returns {Promise<string>} Message ID
     */
    async urlButtons(jid, options) {
        return await sendUrlButtons(this.sock, jid, options);
    }

    /**
     * Send mixed buttons (quick reply + URL)
     * @param {string} jid - Destination JID
     * @param {Object} options - Button options
     * @returns {Promise<string>} Message ID
     */
    async mixedButtons(jid, options) {
        return await sendMixedButtons(this.sock, jid, options);
    }

    /**
     * Send an interactive list
     * @param {string} jid - Destination JID
     * @param {Object} options - List options
     * @returns {Promise<string>} Message ID
     */
    async list(jid, options) {
        return await sendList(this.sock, jid, options);
    }
}

// Export direct functions for functional style
module.exports = StephUI;
module.exports.sendCarousel = sendCarousel;
module.exports.sendButtons = sendButtons;
module.exports.sendUrlButtons = sendUrlButtons;
module.exports.sendMixedButtons = sendMixedButtons;
module.exports.sendList = sendList;
module.exports.formatText = formatText;
module.exports.translateIfNeeded = translateIfNeeded;
