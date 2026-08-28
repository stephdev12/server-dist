import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { ConvexClient } from 'convex/browser';
import { api } from '../frontend/convex/_generated/api.js';
import { whatsappManager } from './whatsapp.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { exec, execSync } from 'child_process';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper d'installation séquentielle des dépendances pour serveurs à faible mémoire (ex: Katabump)
const renDir = path.join(__dirname, '..', 'ren');
const packageJsonPath = path.join(renDir, 'package.json');

if (fs.existsSync(packageJsonPath)) {
  const nodeModulesPath = path.join(renDir, 'node_modules');
  const sentinelPath = path.join(nodeModulesPath, '.installed');
  
  const packageContent = fs.readFileSync(packageJsonPath, 'utf8');
  const currentHash = crypto.createHash('md5').update(packageContent).digest('hex');
  
  let needsInstall = true;
  if (fs.existsSync(sentinelPath)) {
    try {
      const installedHash = fs.readFileSync(sentinelPath, 'utf8').trim();
      if (installedHash === currentHash) {
        needsInstall = false;
      }
    } catch (e) {}
  }
  
  if (needsInstall) {
    console.log('📦 Helper Mémoire : installation des dépendances du bot (ren)...');
    try {
      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }
      
      execSync('npm install --no-audit --no-fund --omit=dev --prefer-offline', {
        cwd: renDir,
        stdio: 'inherit'
      });
      
      fs.writeFileSync(sentinelPath, currentHash, 'utf8');
      console.log('✅ Dépendances du bot installées avec succès.');
    } catch (err) {
      console.error('❌ Échec de l\'installation des dépendances :', err.message);
    }
  }
}

// Map to cache active automations from Convex
const globalAutomations = new Map();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'UP', engine: 'Whatooz Master Bot Core' });
});

import axios from 'axios';

// In-memory chat history cache: key = `${automationId}_${sender}`, value = Array of message objects [{role: 'user'|'assistant', content: '...'}]
const chatHistoryCache = new Map();
const MAX_HISTORY_LEN = 10;

app.post('/api/ai-intent', async (req, res) => {
  try {
    const { automationId, message, sender, pushName } = req.body;
    if (!automationId || !message) return res.status(400).json({ error: 'Missing params' });

    console.log(`[AI INTENT] Requête reçue pour le bot ${automationId} : "${message}" (Expéditeur: ${sender || 'Inconnu'})`);

    // Fetch fresh automation settings from Convex to ensure toggle values are always up to date
    const auto = await client.query(api.automations.getOne, { id: automationId, token: process.env.MASTER_TOKEN });

    if (!auto || !auto.aiModeEnabled) {
      console.log(`[AI INTENT] Mode IA désactivé ou bot non trouvé pour ${automationId}`);
      return res.json({ success: false, reason: 'AI Mode disabled' });
    }

    const contextPath = path.join(__dirname, '..', 'instances', `whatoo_${automationId}`, 'ai_context.json');
    let aiContext = [];
    if (fs.existsSync(contextPath)) {
      try {
        aiContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      } catch (err) {
        console.error(`[AI INTENT] Erreur lecture ai_context.json :`, err.message);
      }
    }

    let candidate = 'NO_MATCH';

    // Only run Gemini intent classification if we have triggers defined
    if (aiContext.length > 0) {
      console.log(`[AI INTENT] Contexte chargé (${aiContext.length} actions). Envoi à Gemini pour détection d'intention...`);

      const prompt = `Tu es une IA d'analyse d'intention pour un chatbot WhatsApp E-commerce.
L'utilisateur a envoyé le message suivant : "${message}"

Voici la liste des actions possibles configurées par le marchand au format JSON :
${JSON.stringify(aiContext)}

Tâche :
Détermine si l'intention de l'utilisateur correspond très clairement (avec plus de 50% de certitude) à l'une des actions ci-dessus.
- Si OUI, retourne UNIQUEMENT le texte exact du champ "trigger" de l'action correspondante. (Exemple: .cat_1)
- Si NON, retourne exactement: NO_MATCH
Ne rajoute aucune explication ni ponctuation. Seulement le trigger ou NO_MATCH.`;

      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 800
            }
          });
          const rawCandidate = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          console.log(`[AI INTENT] Réponse brute Gemini : "${rawCandidate}"`);
          if (rawCandidate) {
            candidate = rawCandidate;
          }
        } catch (geminiErr) {
          console.error(`[AI INTENT] Erreur API Gemini :`, geminiErr.message);
        }
      } else {
        console.warn("[AI INTENT] GEMINI_API_KEY non configurée. Passage direct au mode conversation.");
      }
    }

    // Normalize candidate comparison (e.g. remove markdown, dots, or quotes)
    const normalizedCandidate = candidate.replace(/[`"'\.]/g, '').trim().toUpperCase();

    if (normalizedCandidate && normalizedCandidate !== 'NO_MATCH') {
       console.log(`[AI INTENT] Intention détectée ! Trigger correspondant : "${candidate}"`);
       return res.json({ success: true, trigger: candidate });
    }

    // --- NO INTENT MATCH FOUND ---
    // If conversation mode is enabled, we use OpenRouter to generate a natural chat reply
    if (auto.aiConversationModeEnabled) {
      console.log(`[AI CHAT] Aucune intention e-commerce directe. Mode Conversation actif. Appel OpenRouter pour ${automationId}...`);
      
      const openrouterApiKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterApiKey) {
        console.warn("[AI CHAT] OPENROUTER_API_KEY non configurée dans .env.");
        return res.json({ success: true, trigger: null, chatReply: "Désolé, le service de conversation IA n'est pas configuré." });
      }

      // Fetch catalog to construct context
      let catalogContext = "";
      try {
        const catalogs = await client.query(api.catalogs.listByAutomation, {
          automationId,
          token: process.env.MASTER_TOKEN
        });
        if (catalogs && catalogs.length > 0) {
          catalogContext = "Voici notre catalogue de produits actuel :\n";
          for (const cat of catalogs) {
            for (const category of (cat.categories || [])) {
              catalogContext += `Catégorie: ${category.name}\n`;
              for (const product of (category.products || [])) {
                catalogContext += `- ${product.name} : ${product.price} FCFA`;
                if (product.description) {
                  catalogContext += ` (${product.description})`;
                }
                if (product.negotiableMargin !== undefined && product.negotiableMargin !== null && product.negotiableMargin > 0) {
                  const minPrice = product.price * (1 - (product.negotiableMargin / 100));
                  catalogContext += ` [NÉGOCIATION : Prix de base ${product.price} FCFA. Remise maximum de ${product.negotiableMargin}%. Ne descends JAMAIS en dessous de ${minPrice} FCFA. Propose toujours le prix de base au début, puis négocie de petites remises de 2% à 5% seulement si le client demande un rabais]`;
                } else {
                  catalogContext += ` [NON NÉGOCIABLE : Le prix de ${product.price} FCFA est ferme]`;
                }
                catalogContext += "\n";
              }
            }
          }
        }
      } catch (catErr) {
        console.error(`[AI CHAT] Erreur de chargement du catalogue pour le bot ${automationId}:`);
      }

      const baseInstructions = auto.customPrompt 
        ? auto.customPrompt 
        : `Tu es l'agent IA officiel de la boutique "${auto.name || 'Whatooz'}". Tu es un vendeur poli, chaleureux et professionnel. Ton objectif est de conseiller le client et de l'aider à acheter. Utilise le tutoiement ou vouvoiement selon la politesse standard. Réponds en français.`;

      const systemPrompt = `${baseInstructions}

${catalogContext}

Consignes comportementales strictes :
1. N'invente JAMAIS des produits non listés dans le catalogue.
2. Si le client négocie le prix des produits négociables, ne donne JAMAIS le prix minimum immédiatement. Débute par le prix de base. Si le client insiste, propose de petites remises progressives (de 2% à 5% à la fois), sans jamais descendre en dessous du prix minimum autorisé pour chaque produit.
3. Si le client propose un prix inférieur au prix minimum autorisé, refuse poliment et indique que le dernier prix possible est le prix minimal autorisé.
4. Réponds toujours de manière brève, concise et adaptée à une conversation WhatsApp (pas de longs textes ni de paragraphes volumineux).
5. Si le client souhaite commander ou est d'accord sur le prix, indique-lui comment procéder ou invite-le à exprimer clairement son intention d'achat.`;

      // Get rolling history for this thread
      let history = [];
      let cacheKey = null;
      if (sender) {
        cacheKey = `${automationId}_${sender}`;
        history = chatHistoryCache.get(cacheKey) || [];
      }

      const openrouterMessages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
      ];

      const openrouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
      try {
        const openrouterResponse = await axios.post(openrouterUrl, {
          model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
          messages: openrouterMessages,
          temperature: 0.7,
          max_tokens: 500,
          reasoning: { enabled: true }
        }, {
          headers: {
            'Authorization': `Bearer ${openrouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://whatooz.com',
            'X-Title': 'Whatooz Agent'
          }
        });

        const messageObj = openrouterResponse.data?.choices?.[0]?.message;
        const reply = messageObj?.content?.trim();
        console.log(`[AI CHAT] Réponse OpenRouter pour ${automationId}: "${reply}"`);

        if (reply) {
          // Update rolling history cache
          if (cacheKey) {
            history.push({ role: 'user', content: message });
            
            const assistantMsg = {
              role: 'assistant',
              content: reply
            };
            if (messageObj && messageObj.reasoning_details) {
              assistantMsg.reasoning_details = messageObj.reasoning_details;
            }
            history.push(assistantMsg);

            if (history.length > 10) {
              history = history.slice(history.length - 10);
            }
            chatHistoryCache.set(cacheKey, history);
          }
          return res.json({ success: true, trigger: null, chatReply: reply });
        }
      } catch (orErr) {
        const orErrDetails = orErr?.response?.data || orErr.message;
        console.error(`[AI CHAT] Erreur API OpenRouter :`, orErrDetails);
        return res.json({ success: true, trigger: null, chatReply: "Désolé, je rencontre des difficultés pour répondre à votre message actuellement." });
      }
    }

    console.log(`[AI INTENT] Aucun match (NO_MATCH) pour : "${message}" et conversation désactivée.`);
    return res.json({ success: true, trigger: null });

  } catch (error) {
    const errorDetails = error?.response?.data || error.message;
    console.error('[AI Intent Error]:', errorDetails);
    return res.status(500).json({ error: 'Internal server error', details: errorDetails });
  }
});

app.post('/api/whatsapp-groups', async (req, res) => {
  try {
    const { automationId, groups, token } = req.body;
    const masterToken = process.env.MASTER_TOKEN;
    if (!masterToken || token !== masterToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!automationId || !groups) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    await client.mutation(api.automations.updateWhatsappGroups, {
      id: automationId,
      groups,
      token: masterToken
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('[Groups Sync Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Configure Convex Client connection URL
const CONVEX_URL = process.env.CONVEX_URL;
const MASTER_TOKEN = process.env.MASTER_TOKEN;

if (!CONVEX_URL) {
  console.error("❌ Erreur: CONVEX_URL n'est pas défini dans l'environnement (.env).");
  process.exit(1);
}

if (!MASTER_TOKEN) {
  console.warn("⚠️ Attention: MASTER_TOKEN n'est pas défini. Les fonctions sécurisées risquent d'échouer.");
}

console.log(`[INIT] Connexion à Convex sur : ${CONVEX_URL}`);
if (MASTER_TOKEN) {
  console.log(`[INIT] Master Token chargé : [ ${MASTER_TOKEN.substring(0, 4)}... ] (Longueur: ${MASTER_TOKEN.length})`);
} else {
  console.log(`[INIT] Master Token chargé : NON`);
}
const client = new ConvexClient(CONVEX_URL);

// Map to track hashes of responses per instance to detect changes and trigger hot-reloads
const lastResponsesHash = new Map();
const activeWatchers = new Map();
const lastCatalogsHash = new Map();
const lastFormsHash = new Map();
const lastGroupSettingsHash = new Map();
// 1. Reactive Sync: Listen to automations assigned to this server or globally
const SERVER_ID = process.env.SERVER_ID;
const SERVER_TOKEN = process.env.SERVER_TOKEN;

const handleAutomationsSync = async (autos) => {
  console.log(`[CONVEX SYNC] Synchronisation : ${autos.length} bot(s) trouvé(s) dans Convex.`);
  
  if (autos.length === 0 && MASTER_TOKEN) {
    console.warn("⚠️ [CONVEX SYNC] Aucun bot trouvé. Vérifiez si MASTER_TOKEN/SERVER_TOKEN est correct.");
  }

  globalAutomations.clear();
  for (const auto of autos) {
    globalAutomations.set(auto._id, auto);
  }

  const currentBotIds = new Set(autos.map(a => a._id));
  
  // Manage START and STOP based on isActive
  for (const auto of autos) {
    const idStr = auto._id;
    const processData = whatsappManager.processes.get(idStr);
    const isRunning = !!processData;

    // Handle explicit Logout/Disconnect request
    if (auto.shouldLogout) {
      console.log(`[CONVEX SYNC] Déconnexion demandée pour le bot ${idStr}. Nettoyage session...`);
      await whatsappManager.logoutInstance(auto._id, client);
      await client.mutation(api.automations.updateStatus, { id: auto._id, status: 'DISCONNECTED', shouldLogout: false, token: MASTER_TOKEN });
      continue;
    }

    // Handle phone number modification / mismatch
    const normalizeNum = (num) => (num || '').replace(/[^0-9]/g, '');
    if (isRunning && auto.phoneNumber && processData.phoneNumber && normalizeNum(processData.phoneNumber) !== normalizeNum(auto.phoneNumber)) {
      console.log(`[CONVEX SYNC] Décalage de numéro détecté pour le bot ${idStr} (${processData.phoneNumber} -> ${auto.phoneNumber}). Redémarrage...`);
      await whatsappManager.stopInstance(auto._id, client, false);
      await whatsappManager.startInstance(auto._id, auto.phoneNumber, client);
      continue;
    }

    const localStatus = whatsappManager.getStatus(idStr).status;
    const shouldStart = (auto.isActive && !isRunning) || (auto.status === 'CONNECTING' && localStatus !== 'CONNECTING');

    if (shouldStart) {
      if (auto.phoneNumber) {
        console.log(`[CONVEX SYNC] Bot "${auto.name}" (${idStr}) : Tentative de démarrage/reconnexion...`);
        await whatsappManager.startInstance(auto._id, auto.phoneNumber, client);
        
        // Attach specific watchers for this bot (responses, catalogs, forms, group_settings)
        if (!activeWatchers.has(idStr)) {
          console.log(`[CONVEX SYNC] Bot "${auto.name}" (${idStr}) : Installation des écouteurs réactifs (réponses/catalogues/protections).`);
          const unsubResponses = client.onUpdate(api.responses.listByAutomation, { automationId: auto._id, token: MASTER_TOKEN }, (responses) => {
            const currentHash = JSON.stringify(responses);
            if (lastResponsesHash.get(idStr) !== currentHash) {
              whatsappManager.rebuildPluginsAndRestart(auto._id, client);
              lastResponsesHash.set(idStr, currentHash);
            }
          });
          const unsubCatalogs = client.onUpdate(api.catalogs.listByAutomation, { automationId: auto._id, token: MASTER_TOKEN }, (catalogs) => {
            const currentHash = JSON.stringify(catalogs);
            if (lastCatalogsHash.get(idStr) !== currentHash) {
              whatsappManager.rebuildPluginsAndRestart(auto._id, client);
              lastCatalogsHash.set(idStr, currentHash);
            }
          });
          const unsubForms = client.onUpdate(api.forms.listByAutomation, { automationId: auto._id, token: MASTER_TOKEN }, (forms) => {
            const currentHash = JSON.stringify(forms);
            if (lastFormsHash.get(idStr) !== currentHash) {
              whatsappManager.rebuildPluginsAndRestart(auto._id, client);
              lastFormsHash.set(idStr, currentHash);
            }
          });
          const unsubGroupSettings = client.onUpdate(api.group_settings.listByAutomation, { automationId: auto._id, token: MASTER_TOKEN }, (groupSettings) => {
            const currentHash = JSON.stringify(groupSettings);
            if (lastGroupSettingsHash.get(idStr) !== currentHash) {
              whatsappManager.rebuildGroupSettings(auto._id, groupSettings);
              lastGroupSettingsHash.set(idStr, currentHash);
            }
          });
          activeWatchers.set(idStr, { unsubResponses, unsubCatalogs, unsubForms, unsubGroupSettings });
        }
      } else {
        console.log(`[CONVEX SYNC] Bot "${auto.name}" (${idStr}) est actif (isActive=true) mais n'a pas encore de numéro de téléphone configuré. En attente de configuration...`);
      }
    } else if (!auto.isActive && isRunning) {
      console.log(`[CONVEX SYNC] Désactivation du bot "${auto.name}" (${idStr}). Arrêt processus...`);
      await whatsappManager.stopInstance(idStr, client, false); // Just pm2 stop
      
      const watchers = activeWatchers.get(idStr);
      if (watchers) {
        watchers.unsubResponses();
        watchers.unsubCatalogs();
        watchers.unsubForms();
        if (watchers.unsubGroupSettings) watchers.unsubGroupSettings();
        activeWatchers.delete(idStr);
      }
    }
  }
  
  // Manage DELETE (cleanup any folder or process not in Convex)
  const instancesDir = path.join(__dirname, '..', 'instances');
  if (fs.existsSync(instancesDir)) {
    try {
      const files = fs.readdirSync(instancesDir);
      for (const file of files) {
        if (file.startsWith('whatoo_')) {
          const runningId = file.replace('whatoo_', '');
          if (!currentBotIds.has(runningId)) {
            // Un bot est présent localement mais plus dans Convex
            if (autos.length === 0 && MASTER_TOKEN) {
               console.warn(`[CONVEX SYNC]⚠️ Nettoyage suspendu pour ${runningId} : La liste Convex est vide alors qu'un MASTER_TOKEN est défini. Possible erreur d'authentification.`);
               continue;
            }

            console.log(`[CONVEX SYNC] Le bot ${runningId} a été supprimé de Convex ou est introuvable. Nettoyage final...`);
            await whatsappManager.stopInstance(runningId, client, true); // pm2 delete + rm folder
            const watchers = activeWatchers.get(runningId);
            if (watchers) {
              watchers.unsubResponses();
              watchers.unsubCatalogs();
              watchers.unsubForms();
              activeWatchers.delete(runningId);
            }
            lastResponsesHash.delete(runningId);
            lastCatalogsHash.delete(runningId);
            lastFormsHash.delete(runningId);
          }
        }
      }
    } catch (e) {
      console.error("[CONVEX SYNC] Erreur lors du nettoyage des instances supprimées:", e.message);
    }
  }
};

if (SERVER_ID && SERVER_TOKEN) {
  console.log(`🚀 [INIT] Mode Multi-Serveur activé. ID Serveur : ${SERVER_ID}`);
  client.onUpdate(api.servers.listForServer, { serverId: SERVER_ID, token: SERVER_TOKEN }, handleAutomationsSync);

  // Heartbeat periodic reporting
  const sendHeartbeat = async () => {
    try {
      const freeMem = Math.round(os.freemem() / (1024 * 1024)); // MB
      const totalMem = Math.round(os.totalmem() / (1024 * 1024)); // MB
      const cpus = os.cpus();
      const cpuUsage = Math.min(100, Math.round((os.loadavg()[0] / cpus.length) * 100));
      const activeInstances = whatsappManager.processes.size;

      await client.mutation(api.servers.heartbeat, {
        serverId: SERVER_ID,
        freeMem,
        totalMem,
        cpuUsage,
        activeInstances,
        token: SERVER_TOKEN,
      });
    } catch (e) {
      console.error(`[HEARTBEAT ERROR] :`, e.message);
    }
  };
  
  setInterval(sendHeartbeat, 15000);
  setTimeout(sendHeartbeat, 2000);

  // Auto-Updater listener
  client.onUpdate(api.servers.getServerConfig, { serverId: SERVER_ID, token: SERVER_TOKEN }, async (serverConfig) => {
    if (serverConfig && serverConfig.shouldUpdate) {
      console.log("⚠️ [AUTO-UPDATER] Signal de mise à jour reçu de l'admin !");
      
      // Stop all processes to prevent locks during git pull / npm install
      for (const runningId of whatsappManager.processes.keys()) {
        await whatsappManager.stopInstance(runningId, client, false);
      }

      console.log("[AUTO-UPDATER] Exécution de git pull...");
      exec('git pull', (err, stdout, stderr) => {
        if (err) {
          console.error("[AUTO-UPDATER ERROR] git pull failed:", err.message);
          return;
        }
        console.log(`[AUTO-UPDATER] git pull OK: ${stdout}`);
        
        console.log("[AUTO-UPDATER] npm install (root et ren)...");
        exec('npm install && cd ren && npm install', async (installErr) => {
          if (installErr) {
            console.error("[AUTO-UPDATER ERROR] npm install failed:", installErr.message);
            return;
          }
          console.log("[AUTO-UPDATER] npm install OK. Signalement de fin de mise à jour...");
          
          await client.mutation(api.servers.confirmUpdateComplete, {
            serverId: SERVER_ID,
            token: SERVER_TOKEN,
          });

          console.log("🔄 [AUTO-UPDATER] Redémarrage de l'agent...");
          process.exit(0);
        });
      });
    }
  });
} else {
  console.log(`🚀 [INIT] Mode Monolithique Global activé (pas de SERVER_ID/SERVER_TOKEN dans .env).`);
  client.onUpdate(api.automations.listAllGlobal, { token: MASTER_TOKEN }, handleAutomationsSync);
}

// 4. Reactive Sync: Listen to product purchases to send post-purchase WhatsApp messages
const processedPurchases = new Set();
client.onUpdate(api.payments.listAllProductPurchases, {}, async (allPurchases) => {
  for (const purchase of allPurchases) {
    if (purchase.status?.toUpperCase() === 'SUCCESSFUL' && !processedPurchases.has(purchase.transId)) {
      processedPurchases.add(purchase.transId);
      
      const whatooId = purchase.automationId;
      if (!whatsappManager.processes.has(whatooId)) continue;
      
      // Fetch the catalog to get the postPurchaseMessage
      try {
        let postPurchaseGroups = [];
        const catalogs = await client.query(api.catalogs.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
        let postMsg = "Merci pour votre achat ! Nous vous contacterons bientôt.";
        let postType = "text";
        let postButtons = [];
        
        if (catalogs && catalogs.length > 0) {
          // Find if any catalog matches or default to the first catalog
          const cat = catalogs.find(c => {
            return (c.categories || []).some(category => 
              (category.products || []).some(p => p.id === purchase.productId)
            );
          }) || catalogs[0];
          
          if (cat) {
              postMsg = cat.postPurchaseMessage || postMsg;
              postType = cat.postPurchaseResponseType || postType;
              postButtons = cat.postPurchaseButtons || [];
              postPurchaseGroups = cat.postPurchaseGroups || [];
          }
        }
        
        console.log(`[POST-PURCHASE] Paiement réussi pour ${purchase.productName} (${purchase.transId}). Envoi du message post-achat à ${purchase.buyerWhatsApp}...`);
        whatsappManager.queuePostPurchaseMessage(whatooId, purchase.buyerWhatsApp, postMsg, postType, postButtons);

        // Envoyer la notification de commande réussie au(x) groupe(s) configuré(s)
        if (postPurchaseGroups && postPurchaseGroups.length > 0) {
          const clientPhone = purchase.buyerWhatsApp.split('@')[0];
          const formattedGroupMsg = `> tel : @${clientPhone}\n` +
                                    `> messages : Commande validée - Produit: ${purchase.productName} - Montant: ${purchase.amount} FCFA - ID Transaction: ${purchase.transId}`;

          for (const groupJid of postPurchaseGroups) {
            console.log(`[POST-PURCHASE ROUTING] Notification de commande envoyée au groupe ${groupJid}`);
            whatsappManager.queuePostPurchaseMessage(whatooId, groupJid, formattedGroupMsg, 'text', []);
          }
        }
      } catch (e) {
        console.error(`[POST-PURCHASE] Erreur lors de l'envoi du message post-achat/notification:`, e.message);
      }
    }
  }
  
  // Limit memory: keep only last 500 processed IDs
  if (processedPurchases.size > 500) {
    const arr = [...processedPurchases];
    processedPurchases.clear();
    arr.slice(-200).forEach(id => processedPurchases.add(id));
  }
});

// 5. Periodic Poller: Check active scheduled broadcasts and execute them
setInterval(async () => {
  try {
    const activeBroadcasts = await client.query(api.broadcasts.listAllActive, { token: process.env.MASTER_TOKEN });
    if (!activeBroadcasts || activeBroadcasts.length === 0) return;

    for (const b of activeBroadcasts) {
      const now = Date.now();
      if (now < b.startDate) continue; // Not started yet

      // Adjust date to client's local time using client's timezoneOffset
      const offsetMinutes = b.timezoneOffset !== undefined ? b.timezoneOffset : 0;
      const clientNowObj = new Date(now - (offsetMinutes * 60 * 1000));
      const currentHHMM = String(clientNowObj.getUTCHours()).padStart(2, '0') + ":" + String(clientNowObj.getUTCMinutes()).padStart(2, '0');

      // Check if today is a scheduled day
      let isScheduledDay = false;
      const scheduleType = b.scheduleType || 'interval';

      if (scheduleType === 'weekly') {
        const currentDayOfWeek = clientNowObj.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
        const daysOfWeek = b.daysOfWeek || [];
        isScheduledDay = daysOfWeek.includes(currentDayOfWeek);
      } else {
        // Interval scheduling: check if calendar day difference modulo intervalDays is 0
        const dStart = Math.floor((b.startDate - (offsetMinutes * 60 * 1000)) / (24 * 60 * 60 * 1000));
        const dNow = Math.floor((now - (offsetMinutes * 60 * 1000)) / (24 * 60 * 60 * 1000));
        const diffDays = dNow - dStart;
        const intervalDays = b.intervalDays || 1;
        isScheduledDay = diffDays >= 0 && (diffDays % intervalDays === 0);
      }

      if (!isScheduledDay) continue;

      // Check slot times (timeOfDay / timeOfDay2)
      const timeOfDay = b.timeOfDay || "08:30";
      const timeOfDay2 = b.timeOfDay2 || "15:30";
      const frequency = b.frequency || 1;

      let shouldSend = false;

      if (!b.lastSentAt) {
        // First send ever: check if we are past the timeOfDay
        if (currentHHMM >= timeOfDay) {
          shouldSend = true;
        }
      } else {
        const clientLastSentObj = new Date(b.lastSentAt - (offsetMinutes * 60 * 1000));
        const sentToday = clientLastSentObj.getUTCDate() === clientNowObj.getUTCDate() &&
                          clientLastSentObj.getUTCMonth() === clientNowObj.getUTCMonth() &&
                          clientLastSentObj.getUTCFullYear() === clientNowObj.getUTCFullYear();

        if (!sentToday) {
          // Hasn't been sent today, check if current time is >= timeOfDay
          if (currentHHMM >= timeOfDay) {
            shouldSend = true;
          }
        } else if (frequency === 2) {
          // Sent today already, check if we need to send the second slot today
          const lastSentHours = clientLastSentObj.getUTCHours();
          const lastSentMinutes = clientLastSentObj.getUTCMinutes();
          const slot2H = parseFloat(timeOfDay2.split(':')[0]);
          const slot2M = parseFloat(timeOfDay2.split(':')[1]);
          
          const sentBeforeSlot2 = lastSentHours < slot2H || (lastSentHours === slot2H && lastSentMinutes < slot2M);
          if (sentBeforeSlot2 && currentHHMM >= timeOfDay2) {
            shouldSend = true;
          }
        }
      }

      if (shouldSend) {
        console.log(`[BROADCAST POLLER] Exécution de la diffusion ${b._id} pour le bot ${b.automationId}...`);
        
        let responseType = b.isGroupStatus ? 'group_status' : (b.buttonType || 'text');
        let buttons = [];
        if (!b.isGroupStatus) {
          if (b.buttonType === 'link' && b.buttonText && b.buttonValue) {
            buttons = [b.buttonText, b.buttonValue];
          } else if (b.buttonType === 'call' && b.buttonText && b.buttonValue) {
            buttons = [b.buttonText, b.buttonValue];
          }
        }

        // Resolve destination JIDs (groups vs prospects vs clients)
        let recipientJids = [];
        const audience = b.audience || 'groups';

        if (audience === 'groups') {
          recipientJids = b.groupJids || [];
        } else {
          try {
            const prospects = await client.query(api.automations.getProspectsForAutomation, { 
              automationId: b.automationId, 
              token: process.env.MASTER_TOKEN 
            });
            if (audience === 'prospects') {
              recipientJids = prospects.filter(p => !p.hasPurchased).map(p => p.clientNumber);
            } else if (audience === 'clients') {
              recipientJids = prospects.filter(p => p.hasPurchased).map(p => p.clientNumber);
            }
          } catch (e) {
            console.error(`[BROADCAST POLLER] Erreur récupération prospects pour ${b.automationId}:`, e.message);
          }
        }

        let successfullyQueued = false;
        let groupIndex = 0;
        for (const targetJid of recipientJids) {
          try {
            // Stagger delay per group: 5 minutes if it is a group status, 2 minutes otherwise to prevent WhatsApp spam bans
            let delayMs = 0;
            if (targetJid.endsWith('@g.us')) {
              const staggerTime = b.isGroupStatus ? 5 * 60 * 1000 : 2 * 60 * 1000;
              delayMs = groupIndex * staggerTime;
              groupIndex++;
              console.log(`[BROADCAST POLLER] Envoi différé de ${delayMs / 1000}s pour le groupe ${targetJid} (Status: ${b.isGroupStatus || false})`);
            }

            whatsappManager.queuePostPurchaseMessage(
              b.automationId,
              targetJid,
              b.messageText,
              responseType,
              buttons,
              b.imageUrl,
              delayMs
            );
            successfullyQueued = true;
          } catch (err) {
            console.error(`[BROADCAST POLLER] Erreur file d'attente pour le destinataire ${targetJid}:`, err.message);
          }
        }

        // Even if audience is empty, we must mark it as sent for this slot to avoid looping every 60s
        if (successfullyQueued || recipientJids.length === 0) {
          await client.mutation(api.broadcasts.markSent, {
            id: b._id,
            token: process.env.MASTER_TOKEN
          });
        }
      }
    }
  } catch (error) {
    console.error('[BROADCAST POLLER] Erreur poller diffusions:', error.message);
  }
}, 60000);


// Clean up processes on server shutdown
const cleanup = () => {
  console.log('[SHUTDOWN] Fermeture du serveur. Nettoyage des instances...');
  for (const runningId of whatsappManager.processes.keys()) {
    whatsappManager.stopInstance(runningId, client);
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const server = createServer(app);

server.listen(port, () => {
  console.log(`🚀 Serveur WhatsApp Core réactif démarré sur http://localhost:${port}`);
});
