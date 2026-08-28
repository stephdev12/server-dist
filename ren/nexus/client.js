// 🌐 NEXUS - CLIENT DE CONNEXION OPTIMISÉ
// Code inspiré par SEN (connexion directe + pairing)

// Import dynamique de baileys sera fait dans connectToWhatsApp
const pino = require('pino');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Gestionnaire d'événements (Handler)
const { messageHandler } = require('./handler');
const { handleKeywordTriggers } = require('./triggerHandler');
const { monitorMessage, monitorGroupUpdate } = require('./monitor'); 
const { getSettings } = require('../lib/database');
const { styleText } = require('../lib/functions');
const groupStatusBridge = require('./groupStatusBridge');

async function connectToWhatsApp() {
    const baileys = await import('baileys');
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(chalk.cyan(`🚀 Lancement de ${config.botName}...`));

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !config.pairingCode,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        getMessage: async (key) => { return undefined }
    });

    // 🔗 GESTION DU PAIRING CODE (Automatique si pas connecté)
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            let phoneNumber = config.phoneNumber?.replace(/[^0-9]/g, '');
            
            if (!phoneNumber) {
                console.log(chalk.red("❌ Aucun numéro de pairing défini dans config.js ou .env !"));
                try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'ERROR', pairingCode: null })); } catch(err) {}
                return;
            }

            console.log(chalk.yellow(`⏳ Demande de pairing pour : ${phoneNumber}`));
            try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'CONNECTING', pairingCode: 'WAITING' })); } catch(err) {}

            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(chalk.green(`\n✅ CODE DE JUMELAGE : ${code}\n`));
                try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'CONNECTING', pairingCode: code })); } catch(err) {}
            } catch (e) {
                console.log(chalk.red("❌ Erreur pairing (Vérifiez le numéro) :", e.message));
                try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'ERROR', pairingCode: null })); } catch(err) {}
            }
        }, 4000);
    }

    // 🔄 GESTION DE LA CONNEXION
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(chalk.yellow(`Connexion fermée (Code: ${statusCode}), Reconnexion: ${shouldReconnect}`));
            
            // Reset du bridge group status à la déconnexion
            groupStatusBridge.resetGroupStatusBridge();
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(chalk.red("⛔ Session invalide. Nettoyage du dossier 'session' et arrêt."));
                try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'DISCONNECTED', pairingCode: null })); } catch(err) {}
                try {
                    fs.rmSync(config.sessionName, { recursive: true, force: true });
                } catch (e) {
                    console.log(chalk.red("Erreur lors du nettoyage de la session:", e.message));
                }
                process.exit(1);
            }

            if (shouldReconnect) {
                // Attendre un peu avant de reconnecter pour éviter le spam
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log(chalk.green('✅ Connecté à WhatsApp !'));
            try { fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify({ status: 'CONNECTED', pairingCode: null })); } catch(err) {}

            // ✅ Initialiser le bridge GiftedStatus (baileys-new) sur le socket courant
            // Une seule instance, zéro connexion WA supplémentaire.
            groupStatusBridge.initGroupStatusBridge(sock).catch(e =>
                console.error(chalk.red('[GroupStatusBridge] Erreur init:'), e.message)
            );

            // --- SYNCHRONISATION DES GROUPES WHATSAPP ---
            setTimeout(async () => {
                try {
                    console.log(chalk.cyan('⏳ [SYNC GROUPES] Récupération de la liste des groupes...'));
                    const groupsObject = await sock.groupFetchAllParticipating();
                    const groupsList = [];
                    if (groupsObject) {
                        const botJid = sock.user.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
                        const checkIsAdmin = (metadata) => {
                            if (!botJid || !metadata || !metadata.participants) return false;
                            const botPart = metadata.participants.find(p => p.id.split('@')[0] === botJid.split('@')[0]);
                            return !!(botPart && (botPart.admin === 'admin' || botPart.admin === 'superadmin'));
                        };

                        if (Array.isArray(groupsObject)) {
                            for (const g of groupsObject) {
                                if (g.id && (g.subject || g.name)) {
                                    const isBotAdmin = checkIsAdmin(g);
                                    groupsList.push({ id: g.id, name: g.subject || g.name, isAdmin: isBotAdmin });
                                }
                            }
                        } else {
                            for (const jid of Object.keys(groupsObject)) {
                                const g = groupsObject[jid];
                                if (jid && g && (g.subject || g.name)) {
                                    const isBotAdmin = checkIsAdmin(g);
                                    groupsList.push({ id: jid, name: g.subject || g.name, isAdmin: isBotAdmin });
                                }
                            }
                        }
                    }
                    console.log(chalk.green(`✅ [SYNC GROUPES] ${groupsList.length} groupes trouvés.`));
                    
                    const automationId = process.env.WHATOO_ID;
                    const token = process.env.MASTER_TOKEN;
                    const serverPort = process.env.MASTER_PORT || process.env.PORT || 3000;
                    if (automationId && token) {
                        const axios = require('axios');
                        const url = `http://localhost:${serverPort}/api/whatsapp-groups`;
                        await axios.post(url, {
                            automationId,
                            groups: groupsList,
                            token
                        });
                        console.log(chalk.green('✅ [SYNC GROUPES] Groupes synchronisés avec succès.'));
                    } else {
                        console.log(chalk.yellow(`⚠️ [SYNC GROUPES] Synchronisation impossible : automationId=${automationId}, token=${token ? 'DÉFINI' : 'MANQUANT'}`));
                    }
                } catch (e) {
                    console.error(chalk.red("❌ [SYNC GROUPES] Erreur lors de la synchronisation :"), e.message);
                }
            }, 6000);

            // 0. POLL POUR RELANCES AUTO
            setInterval(async () => {
                try {
                    const axios = require('axios');
                    const httpUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site");
                    const automationId = process.env.WHATOO_ID;
                    if (!automationId) return;

                    const res = await axios.post(`${httpUrl}/get-pending-messages`, { automationId, token: process.env.MASTER_TOKEN });
                    if (res.data && res.data.success && res.data.messages) {
                        for (const msg of res.data.messages) {
                            await sock.sendMessage(msg.clientNumber + '@s.whatsapp.net', { text: msg.messageText });
                        }
                    }
                } catch(e) {
                    // console.error("Poller relances:", e.message); // Silenced to avoid spam
                }
            }, 60000);

            // 1. AUTO FOLLOW NEWSLETTER
            try {
                await sock.newsletterFollow("120363420601379038@newsletter"); 
                await sock.newsletterFollow("120363419924327792@newsletter"); 
                if (config.newsletterJid && !config.newsletterJid.includes('120363161513685998')) {
                     await sock.newsletterFollow(config.newsletterJid);
                }
            } catch (e) {} 

            // 2. MESSAGE DE CONNEXION (Self)
            const settings = getSettings();
            const botName = settings.botName || config.botName;
            const prefix = settings.prefix || config.prefix;
            
            // Compter les plugins (Correction: charge les fichiers pour compter les tableaux)
            let pluginCount = 0;
            const pluginDir = path.join(__dirname, '../plugins');
            if (fs.existsSync(pluginDir)) {
                fs.readdirSync(pluginDir).forEach(cat => {
                    const catPath = path.join(pluginDir, cat);
                    if (fs.lstatSync(catPath).isDirectory()) {
                        fs.readdirSync(catPath).filter(f => f.endsWith('.js')).forEach(file => {
                            try {
                                const plugin = require(path.join(catPath, file));
                                if (Array.isArray(plugin)) {
                                    pluginCount += plugin.length;
                                } else if (plugin.name) {
                                    pluginCount++;
                                }
                            } catch (e) {}
                        });
                    }
                });
            }

            const caption = `> *CONNECT SUCCESSFUL*\n\n` +
                            `➠ *BOTNAME* : ${botName}\n` +
                            `➠ *OWNER* : ${config.ownerName}\n` +
                            `➠ *PREFIX* : ${prefix}\n` +
                            `➠ *PLUGINS* : ${pluginCount}\n\n` +
                            `> ${styleText(`type ${prefix}menu to start`)}`;

            const connectionImage = path.join(__dirname, '..', 'ig.jpg');
            const images = settings.menuImages && settings.menuImages.length > 0 
                ? settings.menuImages 
                : ["https://i.postimg.cc/mDhT0csk/5d815d55908eafd04d29d88e5146a0f9.jpg"];
            const randomImage = images[Math.floor(Math.random() * images.length)];

            // Envoi au bot lui-même
            const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            
            await sock.sendMessage(botJid, { 
                image: fs.existsSync(connectionImage) ? { url: connectionImage } : { url: randomImage },
                caption: caption
            });

            // 🔄 MESSAGE QUEUE PROCESSOR (Post-purchase messages, etc.)
            const queueDir = path.join(process.cwd(), 'message_queue');
            const processMessageQueue = async () => {
                if (sock.isQueueProcessing) return;
                sock.isQueueProcessing = true;
                try {
                    if (!fs.existsSync(queueDir)) {
                        sock.isQueueProcessing = false;
                        return;
                    }
                    const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
                    
                    for (const file of files) {
                        const filePath = path.join(queueDir, file);
                        if (!fs.existsSync(filePath)) continue;
                        
                        try {
                            const msgData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                            
                            // Stagger: If scheduled timestamp is in the future, skip this message for now
                            if (msgData.timestamp && Date.now() < msgData.timestamp) {
                                continue;
                            }

                             const responseType = msgData.responseType || 'text';

                             if (responseType === 'group_status') {
                                   try {
                                       let statusContent = {};
                                       if (msgData.imageUrl) {
                                           statusContent = {
                                               image: { url: msgData.imageUrl },
                                               caption: msgData.text
                                           };
                                       } else {
                                           statusContent = {
                                               message: {
                                                   extendedTextMessage: {
                                                       text: msgData.text,
                                                       backgroundArgb: 0xff000000,
                                                       textArgb: 0xffffffff,
                                                       font: 1
                                                   }
                                               }
                                           };
                                       }
                                       
                                       console.log(`[Queue] Envoi du statut de groupe à ${msgData.to}`);
                                       await sock.sendMessage(msgData.to, {
                                           groupStatusMessage: statusContent
                                       });
                                   } catch (err) {
                                       console.error(`[Queue] Erreur d'envoi du statut de groupe:`, err);
                                   }
                             } else if (['buttons', 'link', 'contact', 'call', 'phone', 'copy'].includes(responseType) && msgData.buttons && msgData.buttons.length > 0) {
                                 const StephUI = require('../lib/stephtech-ui');
                                 const ui = new StephUI(sock);
                                 
                                 let formattedButtons = [];
                                 if (responseType === 'buttons') {
                                     formattedButtons = msgData.buttons.map((btn, idx) => {
                                         const btnStr = typeof btn === 'string' ? btn : (btn.text || '');
                                         const parts = btnStr.split('|');
                                         const actionId = parts[0].trim();
                                         const displayText = parts.length > 1 ? parts[1].trim() : actionId;
                                         return { id: actionId, text: displayText };
                                     });
                                 } else if (responseType === 'link') {
                                     const btnData = msgData.buttons[0];
                                     let btnText = 'Lien';
                                     let btnUrl = 'https://whatooz.com';
                                     const btnStr = typeof btnData === 'string' ? btnData : (btnData.text || '');
                                     if (btnStr.includes('|')) {
                                         const parts = btnStr.split('|');
                                         btnText = parts[0].trim();
                                         btnUrl = parts[1].trim();
                                     } else if (typeof btnData === 'string') {
                                         btnText = msgData.buttons[0] || 'Lien';
                                         btnUrl = msgData.buttons[1] || 'https://whatooz.com';
                                     } else {
                                         btnText = btnData.text || 'Lien';
                                         btnUrl = btnData.url || 'https://whatooz.com';
                                     }
                                     formattedButtons = [{ text: btnText, url: btnUrl }];
                                 } else if (['contact', 'call', 'phone'].includes(responseType)) {
                                     const btnData = msgData.buttons[0];
                                     let btnText = 'Appeler';
                                     let btnPhone = '';
                                     const btnStr = typeof btnData === 'string' ? btnData : (btnData.text || '');
                                     if (btnStr.includes('|')) {
                                         const parts = btnStr.split('|');
                                         btnText = parts[0].trim();
                                         btnPhone = parts[1].trim();
                                     } else if (typeof btnData === 'string') {
                                         btnText = msgData.buttons[0] || 'Appeler';
                                         btnPhone = msgData.buttons[1] || '';
                                     } else {
                                         btnText = btnData.text || 'Appeler';
                                         btnPhone = btnData.call || btnData.phone_number || btnData.phone || '';
                                     }
                                     formattedButtons = [{ text: btnText, call: btnPhone }];
                                 } else if (responseType === 'copy') {
                                     const btnData = msgData.buttons[0];
                                     let btnText = 'Copier';
                                     let btnCode = msgData.text;
                                     const btnStr = typeof btnData === 'string' ? btnData : (btnData.text || '');
                                     if (btnStr.includes('|')) {
                                         const parts = btnStr.split('|');
                                         btnText = parts[0].trim();
                                         btnCode = parts[1].trim();
                                     } else if (typeof btnData === 'string') {
                                         btnText = msgData.buttons[0] || 'Copier';
                                         btnCode = msgData.buttons[1] || msgData.text;
                                     } else {
                                         btnText = btnData.text || 'Copier';
                                         btnCode = btnData.copy || msgData.text;
                                     }
                                     formattedButtons = [{ text: btnText, copy: btnCode }];
                                 }

                                 await ui.buttons(msgData.to, {
                                     text: msgData.text,
                                     image: msgData.imageUrl || null,
                                     buttons: formattedButtons
                                 });
                             } else {
                                 // Send standard message (text or image)
                                 const messageOptions = {};
                                 if (msgData.imageUrl) {
                                     messageOptions.image = { url: msgData.imageUrl };
                                     messageOptions.caption = msgData.text;
                                 } else {
                                     messageOptions.text = msgData.text;
                                 }

                                 // Handle mentions if present
                                 const mentions = [];
                                 const textForMentions = msgData.text || '';
                                 if (textForMentions.includes('@')) {
                                     const matches = textForMentions.match(/@\d+/g);
                                     if (matches) {
                                         for (const match of matches) {
                                             mentions.push(match.substring(1) + '@s.whatsapp.net');
                                         }
                                     }
                                 }
                                 if (mentions.length > 0) {
                                     messageOptions.mentions = mentions;
                                 }

                                 await sock.sendMessage(msgData.to, messageOptions);
                             }
                            
                            // Delete processed file
                            fs.unlinkSync(filePath);
                            console.log(chalk.green(`[QUEUE] Message envoyé à ${msgData.to}`));
                        } catch (e) {
                            console.error(`[QUEUE] Erreur traitement ${file}:`, e.message);
                            // Delete broken files to avoid infinite retries
                            try { fs.unlinkSync(filePath); } catch(_) {}
                        }
                    }
                } catch (e) {
                    console.error("[QUEUE] Erreur critique poller:", e.message);
                } finally {
                    sock.isQueueProcessing = false;
                }
            };
            
            // Run every 2 seconds for high responsiveness
            if (sock.queueInterval) clearInterval(sock.queueInterval);
            sock.queueInterval = setInterval(processMessageQueue, 2000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 📩 GESTION DES MESSAGES (Handler + Monitor)
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg) return;

        // --- GLOBAL LID PATCH ---
        // Convert LID to true PN to ensure Baileys routes responses properly in DMs
        if (msg.key.senderPn && !msg.key.remoteJid.endsWith('@g.us')) {
            msg.key.remoteJid = msg.key.senderPn;
        }

        // --- GESTION DES STATUTS ---
        if (msg.key.remoteJid === 'status@broadcast' && !msg.key.fromMe) {
            try {
                const settings = getSettings();
                const participant = msg.key.participant;

                if (!participant) return;

                if (settings.autostatusview) {
                    await sock.readMessages([msg.key]);
                    console.log(chalk.green(`[STATUS] Vu : ${participant}`));
                }

                if (settings.autostatusreact) {
                    const delay = Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;
                    setTimeout(async () => {
                        try {
                            await sock.sendMessage('status@broadcast', { 
                                react: { text: '💚', key: msg.key } 
                            }, { statusJidList: [participant] });
                        } catch (reactErr) {}
                    }, delay); 
                }
            } catch (statusErr) {
                console.error(chalk.yellow(`[STATUS ERROR] ${statusErr.message} (Bot continue)`));
            }
            return;
        }

        if (m.type === 'notify') {
           const settings = getSettings();
           const chatId = msg.key.remoteJid;

           if (settings.autotyping) {
               await sock.sendPresenceUpdate('composing', chatId);
               setTimeout(() => sock.sendPresenceUpdate('paused', chatId), 5000);
           } else if (settings.autorecord) {
               await sock.sendPresenceUpdate('recording', chatId);
               setTimeout(() => sock.sendPresenceUpdate('paused', chatId), 5000);
           }

           await monitorMessage(sock, m);
           const handledByTrigger = await handleKeywordTriggers(sock, msg);
           if (!handledByTrigger) {
               await messageHandler(sock, m);
           }
        }
    });

    // 👥 GESTION DES GROUPES (Promote/Demote/Welcome)
    sock.ev.on('group-participants.update', async (update) => {
        await monitorGroupUpdate(sock, update);
    });

    return sock;
}

module.exports = { connectToWhatsApp };