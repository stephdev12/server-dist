'use strict';

const {  generateWAMessageFromContent, prepareWAMessageMedia, proto  } = require('baileys');
const {  translateIfNeeded  } = require('./utils');

/**
 * Sends an iOS-Compatible Carousel message using the strictly required modern structure:
 * interactiveMessage -> carouselMessage -> cards -> nativeFlowMessage.
 * 
 * @param {Object} sock - Baileys socket instance
 * @param {string} jid - Destination JID
 * @param {Object} options - Carousel options
 * @returns {Promise<string>} Message ID
 */
async function sendCarousel(sock, jid, options = {}) {
    const { 
        header = "", 
        cards = [], 
        footer = "", 
        quoted = null, 
        maxCards = 10 
    } = options;

    if (!sock || !jid) throw new Error('sock and jid are required');
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('cards required');

    const finalHeader = translateIfNeeded(header, options);
    const limitedCards = cards.slice(0, maxCards);

    try {
        const cardsContent = await Promise.all(
            limitedCards.map(async (card) => {
                let cardHeader = { 
                    title: card.title || "", 
                    hasMediaAttachment: false 
                };
                
                if (card.image) {
                    const media = await prepareWAMessageMedia({ image: { url: card.image } }, { upload: sock.waUploadToServer });
                    cardHeader = { 
                        title: card.title || "", 
                        hasMediaAttachment: true, 
                        imageMessage: media.imageMessage 
                    };
                }

                // IMPORTANT: Each card MUST have a nativeFlowMessage for buttons on iOS
                return {
                    header: cardHeader,
                    body: { text: card.body || "" },
                    footer: { text: card.footer || "" },
                    nativeFlowMessage: {
                        buttons: (card.buttons || []).map(btn => {
                            const isUrl = btn.type === 'url' || btn.type === 'cta_url' || btn.url;
                            const isCopy = btn.type === 'copy' || btn.type === 'cta_copy' || btn.copy !== undefined || btn.copyCode !== undefined;
                            const isCall = btn.type === 'call' || btn.type === 'cta_call' || btn.call;
                            if (isUrl) {
                                return {
                                    name: "cta_url",
                                    buttonParamsJson: JSON.stringify({ 
                                        display_text: btn.text, 
                                        url: btn.url, 
                                        merchant_url: btn.url 
                                    })
                                };
                            } else if (isCopy) {
                                const codeToCopy = btn.copy !== undefined ? btn.copy : btn.copyCode;
                                return {
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({ 
                                        display_text: btn.text, 
                                        copy_code: codeToCopy || "" 
                                    })
                                };
                            } else if (isCall) {
                                return {
                                    name: "cta_call",
                                    buttonParamsJson: JSON.stringify({ 
                                        display_text: btn.text, 
                                        phone_number: btn.call 
                                    })
                                };
                            } else {
                                return {
                                    name: "quick_reply",
                                    buttonParamsJson: JSON.stringify({ 
                                        display_text: btn.text, 
                                        id: btn.id 
                                    })
                                };
                            }
                        })
                    }
                };
            })
        );

        const messageContent = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: {
                        header: { title: finalHeader, hasMediaAttachment: false },
                        body: { text: "" }, // Main body is usually empty for carousels
                        footer: { text: footer },
                        carouselMessage: {
                            cards: cardsContent,
                            messageVersion: 1
                        }
                    }
                }
            }
        };

        const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
        const msg = generateWAMessageFromContent(jid, messageContent, { quoted, userJid });
        
        const isPrivate = !jid.endsWith("@g.us");
        const additionalNodes = [
            {
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { name: 'mixed', v: '9' }
                    }]
                }]
            }
        ];
        
        if (isPrivate) {
            additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
        }

        await sock.relayMessage(jid, msg.message, { 
            messageId: msg.key.id, 
            additionalNodes 
        });
        
        return msg.key.id;
    } catch (error) {
        console.error('❌ Error in sendCarousel (iOS Native Structure):', error.message);
        throw error;
    }
}

module.exports = { sendCarousel };
