// 🚀 NEXUS - HANDLER (OPTIMISÉ v5 - DYNAMIQUE & MINIMALISTE)
const path = require('path');
const fs = require('fs');
const config = require('../config');
const chalk = require('chalk');
const { isAdmin, isOwner: checkIsOwner, isSudo, normalizeJid } = require('../lib/authHelper');
const { buildMessageOptions } = require('../lib/utils');
const { getSettings } = require('../lib/database');
const { getRequest, deleteRequest } = require('../lib/store'); // Import Store
const { t } = require('../lib/language'); // Import t()

// Chargement des plugins
const plugins = {};
const aliases = {};

function loadPlugins() {
    console.log(chalk.cyan('📥 Chargement des plugins...'));
    const pluginDir = path.join(__dirname, '../plugins');
    
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir);

    const categories = fs.readdirSync(pluginDir);
    categories.forEach(category => {
        const catPath = path.join(pluginDir, category);
        if (fs.lstatSync(catPath).isDirectory()) {
            fs.readdirSync(catPath).forEach(file => {
                if (file.endsWith('.js')) {
                    try {
                        const pluginModule = require(path.join(catPath, file));
                        // Supporte export unique OU tableau de commandes
                        const commands = Array.isArray(pluginModule) ? pluginModule : [pluginModule];

                        commands.forEach(plugin => {
                            if (plugin && plugin.name) {
                                plugins[plugin.name] = plugin;
                                if (plugin.aliases) {
                                    plugin.aliases.forEach(alias => aliases[alias] = plugin.name);
                                }
                            }
                        });
                    } catch (err) {
                        console.error(chalk.red(`Erreur chargement ${file}:`), err);
                    }
                }
            });
        }
    });
    console.log(chalk.cyan(`✅ ${Object.keys(plugins).length} plugins chargés.\n`));
}

// Handler de message
async function messageHandler(sock, m) {
    try {
        const message = m.messages[0];
        if (!message) return;

        // DEBUG : Voir ce qui arrive (à supprimer plus tard)
        // if (message.key.fromMe) console.log(`[FROM ME] Body: ${message.message?.conversation}`);

        // On accepte les messages du bot s'ils sont du texte (pour les choix interactifs)
        if (message.key.fromMe && !message.message?.conversation && !message.message?.extendedTextMessage) return;

        let chatId = message.key.remoteJid;
        if (message.key.senderPn && !chatId.endsWith('@g.us')) {
            chatId = message.key.senderPn;
            message.key.remoteJid = message.key.senderPn; // Patch for plugins and quoted messages
        }
        const isGroup = chatId.endsWith('@g.us');
        
        // Détermination propre de l'expéditeur
        let sender;
        if (message.key.fromMe) {
            // Pour le bot, on prend l'ID de base sans suffixe (:device)
            sender = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        } else {
            sender = isGroup ? (message.key.participantPn || message.key.participant || message.participant) : chatId;
        }

        // Unpack viewOnceMessage / viewOnceMessageV2
        let msgType = Object.keys(message.message || {})[0];
        let innerMessage = message.message;
        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
            innerMessage = message.message[msgType].message;
        }

        let body = innerMessage?.conversation || 
                     innerMessage?.extendedTextMessage?.text || 
                     innerMessage?.imageMessage?.caption || 
                     innerMessage?.buttonsResponseMessage?.selectedButtonId ||
                     innerMessage?.templateButtonReplyMessage?.selectedId ||
                     innerMessage?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                     "";

        if (!body && innerMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
            try {
                const params = JSON.parse(innerMessage.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                if (params.id) body = params.id;
            } catch(e) {}
        }

        // --- 1. GESTION DES RÉPONSES INTERACTIVES (Store) ---
        let senderNum;
        if (message.key.fromMe) {
            senderNum = normalizeJid(sock.user?.id || "");
        } else {
            senderNum = normalizeJid(sender);
        }

        // Log incoming message (if not from bot itself)
        if (body && !message.key.fromMe) {
            console.log(`[MESSAGE ENTRANT] Expéditeur: ${senderNum}, Chat: ${chatId}, Message: "${body}"`);
        }
        
        // --- 0. ANNULER LES RELANCES EN COURS ---
        if (!message.key.fromMe && !isGroup) {
            const axios = require('axios');
            if (process.env.CONVEX_URL && process.env.MASTER_TOKEN) {
                const httpUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site");
                const clientNumber = senderNum.split('@')[0];
                axios.post(`${httpUrl}/cancel-followups`, { clientNumber, token: process.env.MASTER_TOKEN }).catch(() => {});
            }
        }
        
        const pendingRequest = getRequest(senderNum, chatId);

        if (pendingRequest) {
            // Si c'est une nouvelle commande (commence par .), on annule la requête en cours
            const settings = getSettings();
            const prefix = settings.prefix || config.prefix;
            
            if (body.startsWith(prefix)) {
                deleteRequest(senderNum, chatId);
            } else {
                // Sinon, on traite la réponse
                const plugin = plugins[pendingRequest.command];
                if (plugin && plugin.handleResponse) {
                    await plugin.handleResponse(sock, message, body, pendingRequest);
                    return; // Stop ici, on a traité la réponse
                }
            }
        }

        // --- 1.4. ANALYSE D'INTENTION IA (MODE IA PREMIUM) ---
        const settings = getSettings();
        const prefix = settings.prefix || config.prefix;
        let aiModeReplaced = false;

        if (!message.key.fromMe && body && !body.startsWith(prefix) && !isGroup) {
            // Optimisation du flux (économie de tokens Gemini) :
            // Ignorer les messages purement numériques, trop courts ou constitués uniquement d'emojis
            const trimmedBody = body.trim();
            const isNumeric = /^\d+$/.test(trimmedBody);
            const isTooShort = trimmedBody.length < 2;
            const isEmojiOnly = /^[\p{Emoji}\s]+$/u.test(trimmedBody);

            if (!isNumeric && !isTooShort && !isEmojiOnly) {
                console.log(`[AI MODE] Message non-commande reçu. Envoi au Master Bot pour détection d'intention...`);
                const axios = require('axios');
                try {
                    const localPort = process.env.MASTER_PORT || process.env.PORT || 3000;
                    const path = require('path');
                    const automationId = process.env.WHATOO_ID || path.basename(path.resolve(__dirname, '../')).replace('whatoo_', '');
                    if (automationId) {
                        const { data } = await axios.post(`http://localhost:${localPort}/api/ai-intent`, {
                            automationId: automationId,
                            message: body,
                            sender: message.key.remoteJid,
                            pushName: message.pushName || ''
                        });

                        if (data && data.success && data.trigger) {
                            console.log(`[AI MODE] Intention reconnue par Gemini : "${data.trigger}" (Remplacement de "${body}" par "${prefix + data.trigger}")`);
                            body = prefix + data.trigger;
                            aiModeReplaced = true;

                            // Enregistrer le prospect interactif IA
                            try {
                                const senderNum = message.key.remoteJid;
                                await axios.post(`${(process.env.CONVEX_SITE_URL || process.env.CONVEX_URL.replace(".cloud", ".site"))}/register-interaction`, {
                                    userId: process.env.WHATOO_USER_ID,
                                    automationId: automationId,
                                    clientNumber: senderNum,
                                    clientName: message.pushName || undefined,
                                    interactionType: 'ai'
                                }).catch(() => {});
                            } catch (err) {
                                console.error("Erreur enregistrement prospect AI:", err.message);
                            }

                            // Exécuter immédiatement le gestionnaire de déclencheurs personnalisés avec le nouveau mot-clé
                            const { handleKeywordTriggers } = require('./triggerHandler');
                            const handled = await handleKeywordTriggers(sock, message, body);
                            if (handled) {
                                return; // Stop ici, l'action associée au trigger a été envoyée
                            }
                        } else if (data && data.success && data.chatReply) {
                            console.log(`[AI MODE] Réponse conversationnelle de l'IA reçue : "${data.chatReply}"`);
                            
                            // Mettre l'état en écriture (simulation d'humain qui tape)
                            await sock.sendPresenceUpdate('composing', chatId);
                            
                            // Introduire un léger délai réaliste basé sur la longueur du texte pour faire naturel
                            const delayMs = Math.min(3000, Math.max(1000, data.chatReply.length * 30));
                            await new Promise(resolve => setTimeout(resolve, delayMs));

                            await sock.sendMessage(chatId, { text: data.chatReply }, { quoted: message });
                            await sock.sendPresenceUpdate('paused', chatId);

                            // Enregistrer le prospect interactif IA
                            try {
                                const senderNum = message.key.remoteJid;
                                await axios.post(`${(process.env.CONVEX_SITE_URL || process.env.CONVEX_URL.replace(".cloud", ".site"))}/register-interaction`, {
                                    userId: process.env.WHATOO_USER_ID,
                                    automationId: automationId,
                                    clientNumber: senderNum,
                                    clientName: message.pushName || undefined,
                                    interactionType: 'ai'
                                }).catch(() => {});
                            } catch (err) {
                                console.error("Erreur enregistrement prospect AI:", err.message);
                            }

                            return; // Arrêter ici car l'IA a répondu en mode conversation
                        } else {
                            console.log(`[AI MODE] Aucune intention e-commerce reconnue (NO_MATCH) et pas de chat libre.`);
                        }
                    }
                } catch (e) {
                    console.error("[AI MODE Error]:", e.message || e);
                    if (e.response && e.response.data) {
                        console.error("[AI MODE Response Data]:", typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : e.response.data);
                    }
                    if (e.stack) {
                        console.error("[AI MODE Error Stack]:", e.stack);
                    }
                }
            } else {
                console.log(`[AI MODE] Message ignoré par l'IA (numérique, trop court ou emoji uniquement) pour économiser les tokens.`);
            }
        }

        // --- 1.5. GESTION DU CHATBOT IA (FALLBACK) ---
        const chatbotMode = settings.chatbotMode || 'off';

        if (!aiModeReplaced && chatbotMode !== 'off' && !message.key.fromMe) {
            const isPrivate = !isGroup;
            let shouldReply = false;

            // Déterminer si le chatbot doit s'activer
            if (chatbotMode === 'both') {
                shouldReply = true;
            } else if (chatbotMode === 'private' && isPrivate) {
                shouldReply = true;
            } else if (chatbotMode === 'group' && isGroup) {
                shouldReply = true;
            }

            // Dans un groupe, on veut peut-être qu'il ne réponde QUE si on le mentionne ou on lui répond
            if (shouldReply && isGroup) {
                const quotedParticipant = message.message?.extendedTextMessage?.contextInfo?.participant;
                const botId = normalizeJid(sock.user?.id || "") + "@s.whatsapp.net";
                
                // Si ce n'est pas une réponse au bot et pas de mention au bot, on ignore pour éviter le spam
                if (quotedParticipant !== botId && !body.includes("@" + botId.split('@')[0])) {
                    shouldReply = false;
                }
            }

            // Si le message n'est pas une commande, on envoie à l'IA
            if (shouldReply && body && !body.startsWith(prefix)) {
                // On importe l'API IA dynamiquement pour ne pas bloquer le handler
                const axios = require('axios');
                const API_KEY = 'gifted';
                const prompt = "Tu es REN-MDX, un bot WhatsApp ultra-performant créé par SEN STUDIO. Tu es serviable, rapide et tu aimes la technologie.";
                
                // On met l'état en écriture
                await sock.sendPresenceUpdate('composing', chatId);
                
                try {
                    const { data } = await axios.get(`https://api.giftedtech.co.ke/api/ai/custom?apikey=${API_KEY}&q=${encodeURIComponent(body)}&prompt=${encodeURIComponent(prompt)}`);
                    if (data && data.success && data.result) {
                        await sock.sendMessage(chatId, { text: data.result }, { quoted: message });
                    }
                } catch (e) {
                    console.error("Erreur Chatbot Auto:", e.message);
                }
                
                await sock.sendPresenceUpdate('paused', chatId);
                return; // On arrête l'exécution ici car le chatbot a répondu
            }
        }

        // --- 2. GESTION DES COMMANDES CLASSIQUES ---
        if (!body.startsWith(prefix)) return;
if (body === ".ping") console.log(JSON.stringify(message.key, null, 2));

        const args = body.slice(prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();
        const pluginName = plugins[commandName] ? commandName : aliases[commandName];
        
        if (pluginName) {
            const plugin = plugins[pluginName];
            const senderNum = normalizeJid(sender);
            const isOwner = checkIsOwner(sock, message);
            const isUserSudo = isSudo(sender);

            // --- GESTION DU MODE PUBLIC/PRIVÉ ---
            // Si mode privé : Owner OU Sudo autorisé
            if (settings.mode === 'private' && !isOwner && !isUserSudo) {
                return; // Ignorer silencieusement
            }

            // --- VÉRIFICATIONS ---

            // 1. Owner Only (SILENT FAIL)
            if (plugin.ownerOnly && !isOwner) {
                return; // On ne fait RIEN. On ignore.
            }

            // 2. Group Only
            if (plugin.groupOnly && !isGroup) {
                return sock.sendMessage(chatId, { text: t('system.group_only') }, { quoted: message });
            }

            // 3. Admin Only
            if (plugin.adminOnly && isGroup) {
                const userIsAdmin = await isAdmin(sock, chatId, sender);
                if (!userIsAdmin && !isOwner) {
                    return sock.sendMessage(chatId, { text: t('system.admin_only') }, { quoted: message });
                }
            }

            // --- OPTIONS DE MESSAGE ---
            // On passe 'settings' à buildMessageOptions pour avoir les noms dynamiques
            const msgOptions = buildMessageOptions(plugin, settings);

            // 🚀 EXÉCUTION
            console.log(chalk.yellow(`[EXEC] ${pluginName} par ${senderNum}`));
            await plugin.execute(sock, message, args, msgOptions);
        }

    } catch (e) {
        console.error(chalk.red("Erreur Handler:"), e);
    }
}

module.exports = { loadPlugins, messageHandler };