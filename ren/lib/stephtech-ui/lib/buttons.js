'use strict';

const { 
    generateWAMessageFromContent, 
    prepareWAMessageMedia, 
    proto,
    isJidGroup
} = require('baileys');
const { translateIfNeeded } = require('./utils');

class InteractiveValidationError extends Error {
    constructor(message, { context, errors = [] } = {}) {
        super(message);
        this.name = 'InteractiveValidationError';
        this.context = context;
        this.errors = errors;
    }
}

function getButtonArgs(jid) {
    const isPrivate = !isJidGroup(jid);
    const nodes = [
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
        nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }
    return nodes;
}

function normalizeButtons(buttons) {
    return buttons.map((btn, i) => {
        if (btn.type === 'url' || btn.url) {
            return {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text,
                    url: btn.url,
                    merchant_url: btn.url
                })
            };
        }
        if (btn.type === 'copy' || btn.copy !== undefined || btn.copyCode !== undefined) {
            const codeToCopy = btn.copy !== undefined ? btn.copy : btn.copyCode;
            return {
                name: "cta_copy",
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text,
                    copy_code: codeToCopy || ""
                })
            };
        }
        if (btn.type === 'call' || btn.call) {
            return {
                name: "cta_call",
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text,
                    phone_number: btn.call
                })
            };
        }
        return {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: btn.text,
                id: btn.id || `quick_${i + 1}`
            })
        };
    });
}

async function sendButtons(sock, jid, options = {}) {
    const { text, footer = "", buttons = [], image = null, quoted = null } = options;
    const finalText = translateIfNeeded(text, options);
    const normalizedButtons = normalizeButtons(buttons);

    let header = { hasMediaAttachment: false };
    if (image) {
        const media = await prepareWAMessageMedia({ image: { url: image } }, { upload: sock.waUploadToServer });
        header = { hasMediaAttachment: true, imageMessage: media.imageMessage };
    }

    const messageContent = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: {
                    body: { text: finalText },
                    footer: { text: footer },
                    header: header,
                    nativeFlowMessage: {
                        buttons: normalizedButtons,
                        messageVersion: 1
                    }
                }
            }
        }
    };

    const msg = generateWAMessageFromContent(jid, messageContent, { quoted, userJid: sock.user.id });
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: getButtonArgs(jid) });
    return msg.key.id;
}

async function sendList(sock, jid, options = {}) {
    const { text, title = "", footer = "", buttonText = "Select", sections = [], quoted = null } = options;
    const finalText = translateIfNeeded(text, options);

    const messageContent = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: {
                    body: { text: finalText },
                    footer: { text: footer },
                    header: { title: title, hasMediaAttachment: false },
                    nativeFlowMessage: {
                        buttons: [{
                            name: "single_select",
                            buttonParamsJson: JSON.stringify({
                                title: buttonText,
                                sections: sections.map(s => ({
                                    title: s.title || "",
                                    rows: s.rows.map(r => ({
                                        header: r.title,
                                        title: r.title,
                                        description: r.description || "",
                                        id: r.id || r.rowId
                                    }))
                                }))
                            })
                        }],
                        messageVersion: 1
                    }
                }
            }
        }
    };

    const msg = generateWAMessageFromContent(jid, messageContent, { quoted, userJid: sock.user.id });
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: getButtonArgs(jid) });
    return msg.key.id;
}

module.exports = { sendButtons, sendUrlButtons: (sock, jid, opts) => sendButtons(sock, jid, { ...opts, buttons: opts.buttons.map(b => ({ ...b, type: 'url' })) }), sendMixedButtons: sendButtons, sendList, InteractiveValidationError };
