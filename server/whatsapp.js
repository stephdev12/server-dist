import { spawn, exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { api } from '../frontend/convex/_generated/api.js';

const execPromise = util.promisify(exec);

// Isolate PM2 to local writable directory to prevent EACCES errors on /root/.pm2
const PM2_HOME_DIR = process.env.PM2_HOME || path.join(process.cwd(), '.pm2');
if (!fs.existsSync(PM2_HOME_DIR)) {
  try {
    fs.mkdirSync(PM2_HOME_DIR, { recursive: true });
  } catch (err) {}
}
process.env.PM2_HOME = PM2_HOME_DIR;

const runPm2 = (cmd, options = {}) => {
  return execPromise(`npx pm2 ${cmd}`, {
    ...options,
    env: {
      ...process.env,
      PM2_HOME: PM2_HOME_DIR,
      ...(options.env || {})
    }
  });
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhatsAppInstanceManager {
  constructor() {
    this.processes = new Map(); // whatooId (string) -> { watcher: fs.FSWatcher }
    this.statusMap = new Map(); // whatooId (string) -> { status: 'DISCONNECTED', pairingCode: null }
  }

  getStatus(whatooId) {
    return this.statusMap.get(whatooId) || { status: 'DISCONNECTED', pairingCode: null };
  }

  copyFolderRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true, mode: 0o777 });
    }

    if (typeof fs.cpSync === 'function') {
      try {
        fs.cpSync(src, dest, {
          recursive: true,
          force: true,
          dereference: true,
          filter: (srcPath) => {
            const base = path.basename(srcPath);
            return base !== 'node_modules' && base !== 'session' && base !== '.git';
          }
        });
        return;
      } catch (err) {
        console.warn(`[COPY] fs.cpSync avertissement: ${err.message}. Repli sur copie récursive manuelle...`);
      }
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.name === 'node_modules' || entry.name === 'session' || entry.name === '.git') {
        continue;
      }

      if (entry.isDirectory()) {
        this.copyFolderRecursive(srcPath, destPath);
      } else {
        try {
          fs.copyFileSync(srcPath, destPath);
        } catch (err) {
          console.error(`[COPY] Erreur copie ${srcPath} vers ${destPath}:`, err.message);
        }
      }
    }
  }

  // Compile a response to a REN plugin using gifted-btns
  compileResponseToPlugin(response) {
    const { keywords, response_type, content, buttons } = response;
    
    const kwArray = keywords.split(',').map(k => k.trim());
    const commandName = kwArray[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '');
    const aliases = kwArray.slice(1).map(k => k.toLowerCase().replace(/['"]/g, '\\"'));

    let executeBody = '';

    switch (response_type) {
      case 'text':
        executeBody = `
    await client.sendMessage(message.key.remoteJid, { 
      text: \`${content.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\` 
    }, { quoted: message, ...msgOptions });`;
        break;

      case 'buttons': {
        let parsedButtons = [];
        try { parsedButtons = JSON.parse(buttons || '[]'); } catch (e) {}

        const formatted = parsedButtons.map((btn, idx) => ({
          id: btn.id || `btn_${idx}`,
          text: btn.text
        }));

        executeBody = `
    const StephUI = require('../../lib/stephtech-ui');
    const ui = new StephUI(client);
    await ui.buttons(message.key.remoteJid, {
      text: \`${content.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`,
      buttons: ${JSON.stringify(formatted, null, 2)}
    });`;
        break;
      }

      case 'link': {
        let parsedButtons = [];
        try { parsedButtons = JSON.parse(buttons || '[]'); } catch (e) {}
        const linkUrl = parsedButtons[0]?.url || '';
        const linkText = parsedButtons[0]?.text || 'Visiter';

        executeBody = `
    const StephUI = require('../../lib/stephtech-ui');
    const ui = new StephUI(client);
    await ui.buttons(message.key.remoteJid, {
      text: \`${content.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`,
      buttons: [
        { text: "${linkText.replace(/"/g, '\\"')}", url: "${linkUrl.replace(/"/g, '\\"')}" }
      ]
    });`;
        break;
      }

      case 'contact':
      case 'call': {
        let parsedButtons = [];
        try { parsedButtons = JSON.parse(buttons || '[]'); } catch (e) {}
        const callPhone = parsedButtons[0]?.call || '';
        const callText = parsedButtons[0]?.text || 'Appeler';

        executeBody = `
    const StephUI = require('../../lib/stephtech-ui');
    const ui = new StephUI(client);
    await ui.buttons(message.key.remoteJid, {
      text: \`${content.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`,
      buttons: [
        { text: "${callText.replace(/"/g, '\\"')}", call: "${callPhone.replace(/"/g, '\\"')}" }
      ]
    });`;
        break;
      }

      case 'location': {
        let lat = 0, lng = 0, name = "Localisation";
        try {
          const locData = JSON.parse(content);
          lat = parseFloat(locData.lat);
          lng = parseFloat(locData.lng);
          name = locData.name || name;
        } catch (e) {
          const parts = content.split(',');
          lat = parseFloat(parts[0]) || 0;
          lng = parseFloat(parts[1]) || 0;
          name = parts[2] || name;
        }

        executeBody = `
    await client.sendMessage(message.key.remoteJid, {
      location: {
        degreesLatitude: ${lat},
        degreesLongitude: ${lng},
        name: "${name.replace(/"/g, '\\"')}"
      }
    }, { quoted: message, ...msgOptions });`;
        break;
      }

      case 'copy': {
        let parsedButtons = [];
        try { parsedButtons = JSON.parse(buttons || '[]'); } catch (e) {}
        const copyText = parsedButtons[0]?.text || 'Copier le texte';
        const copyCode = parsedButtons[0]?.copy || content;

        executeBody = `
    const StephUI = require('../../lib/stephtech-ui');
    const ui = new StephUI(client);
    await ui.buttons(message.key.remoteJid, {
      text: \`${content.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`,
      buttons: [
        { text: "${copyText.replace(/"/g, '\\"')}", copy: \`${copyCode.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\` }
      ]
    });`;
        break;
      }

      default:
        executeBody = `
    await client.sendMessage(message.key.remoteJid, { text: \`${content.replace(/`/g, '\\`')}\` }, { quoted: message, ...msgOptions });`;
    }

    return `// 🚀 Plugin généré par Whatoo pour la commande : ${commandName}
module.exports = {
  name: "${commandName}",
  ${aliases.length > 0 ? `aliases: ${JSON.stringify(aliases)},` : ''}
  execute: async (client, message, args, msgOptions) => {
    try {
      if (message.key.remoteJid.endsWith('@g.us')) return;
      ${executeBody}
      
      const axios = require('axios');
      const httpUrl = (process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site"));
      const clientNumber = message.key.remoteJid.split('@')[0];
      axios.post(\`\${httpUrl}/schedule-followups\`, {
        userId: process.env.WHATOO_USER_ID,
        automationId: process.env.WHATOO_ID,
        triggerId: "${response.id}",
        clientNumber: clientNumber
      }).catch(() => {});
      
    } catch (e) {
      console.error("Erreur lors de l'exécution de la commande ${commandName}:", e);
    }
  }
};
`;
  }

  compileAllFormsToPlugin(forms) {
    return `// 🚀 Plugin Master pour les Formulaires
  module.exports = {
  name: "form",
  execute: async (client, message, args, msgOptions) => {
    try {
      if (message.key.remoteJid.endsWith('@g.us')) return;

      const { getRequest, saveRequest } = require('../../lib/store');
      const { normalizeJid } = require('../../lib/authHelper');
      const senderNum = normalizeJid(message.key.fromMe ? client.user.id : (message.key.participant || message.key.remoteJid));

      const pending = getRequest(senderNum, message.key.remoteJid);
      if (pending && pending.command === "form") return;

      if (!args || args.length === 0) {
        await client.sendMessage(message.key.remoteJid, { text: "Veuillez spécifier le nom du formulaire. Exemple: .form sondage" });
        return;
      }
      const triggerWord = args.join(" ").trim().toLowerCase();
      const formsData = ${JSON.stringify(forms)};
      const form = formsData.find(f => {
         const safeTitle = f.title.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]/g, '');
         return safeTitle === triggerWord || f.title.toLowerCase() === triggerWord;
      });

      if (!form) {
        if (!pending) {
          await client.sendMessage(message.key.remoteJid, { text: "Formulaire introuvable." });
        }
        return;
      }

      // Initialisation: On envoie la Q1 et on passe directement au step 1
      const initialRequest = { 
        command: "form", 
        formId: form._id, 
        step: 1, 
        answers: [], 
        lastUpdate: Date.now() 
      };
      saveRequest(senderNum, message.key.remoteJid, initialRequest);

      if (form.questions && form.questions.length > 0) {
        console.log(\`[FORM] Lancement formulaire "\${form.title}" pour \${senderNum}\`);
        await client.sendMessage(message.key.remoteJid, { text: form.questions[0] }, { quoted: message, ...msgOptions });
      }

      const axios = require('axios');
      const httpUrl = (process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site"));
      const clientNumber = message.key.remoteJid.split('@')[0];
      axios.post(\`\${httpUrl}/schedule-followups\`, {
        userId: process.env.WHATOO_USER_ID,
        automationId: process.env.WHATOO_ID,
        triggerId: form._id,
        clientNumber: clientNumber
      }).catch(() => {});

      } catch (e) {
      console.error("Erreur lancement master formulaire:", e);
      }
      },
      handleResponse: async (client, message, body, request) => {
      try {
      const { saveRequest, deleteRequest } = require('../../lib/store');
      const { normalizeJid } = require('../../lib/authHelper');
      const senderNum = normalizeJid(message.key.fromMe ? client.user.id : (message.key.participant || message.key.remoteJid));

      if (request.lastUpdate && Date.now() - request.lastUpdate > 300000) {
        deleteRequest(senderNum, message.key.remoteJid);
        await client.sendMessage(message.key.remoteJid, { text: "Formulaire annulé pour cause d'inactivité." });
        return;
      }

      // Debounce anti-spam
      if (request.lastUpdate && Date.now() - request.lastUpdate < 1000) return;
      request.lastUpdate = Date.now();

      if (body.toLowerCase() === 'annuler') {
        deleteRequest(senderNum, message.key.remoteJid);
        await client.sendMessage(message.key.remoteJid, { text: "Formulaire annulé." });
        return;
      }

      const formsData = ${JSON.stringify(forms)};
      const form = formsData.find(f => f._id === request.formId);
      if (!form) {
         deleteRequest(senderNum, message.key.remoteJid);
         return;
      }

      // On s'assure de ne pas traiter une étape déjà traitée
      const currentStep = request.step;
      request.answers.push(body);

      if (currentStep < form.questions.length) {
        // Passer à la question suivante
        const nextQuestion = form.questions[currentStep];
        request.step = currentStep + 1;
        saveRequest(senderNum, message.key.remoteJid, request);
        await client.sendMessage(message.key.remoteJid, { text: nextQuestion });
      } else {
        // Formulaire terminé: ON SUPPRIME TOUT DE SUITE POUR ÉVITER LES DOUBLONS
        deleteRequest(senderNum, message.key.remoteJid);
        console.log(\`[FORM] Formulaire "\${form.title}" terminé pour \${senderNum}\`);

        // Routage automatique vers groupe WhatsApp si configuré (support multi-groupes)
        const targetGroups = form.destinationGroups || (form.destinationGroup ? [form.destinationGroup] : []);
        if (targetGroups && targetGroups.length > 0) {
          try {
            let formattedMsg = \`📋 *Formulaire rempli : \${form.title}*\\n\\n\`;
            formattedMsg += \`👤 *Client :* @\${senderNum.split('@')[0]}\\n\\n\`;
            form.questions.forEach((q, idx) => {
                formattedMsg += \`❓ *\${q}*\\n👉 \${request.answers[idx] || ''}\\n\\n\`;
            });
            for (const groupJid of targetGroups) {
              if (groupJid) {
                await client.sendMessage(groupJid, {
                  text: formattedMsg,
                  mentions: [senderNum]
                });
                console.log(\`[FORM ROUTING] Résultats envoyés au groupe \${groupJid}\`);
              }
            }
          } catch(routingErr) {
            console.error("Erreur routage formulaire vers groupe:", routingErr.message);
          }
        }

        const axios = require('axios');
        const httpUrl = (process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site"));

        try {
          await axios.post(\`\${httpUrl}/submit-form\`, {
            formId: form._id,
            clientNumber: senderNum,
            answers: request.answers
          });
        } catch(err) {
          console.error("Erreur envoi formulaire à Convex:", err.message);
        }

        if (form.finalResponseType === 'buttons' && form.finalResponseButtons && form.finalResponseButtons.length > 0) {
          const formattedBtns = form.finalResponseButtons.map((btnStr) => {
            const parts = btnStr.split('|');
            const actionId = parts[0].trim();
            const displayText = parts.length > 1 ? parts[1].trim() : actionId;
            return { id: actionId, text: displayText };
          });
          await client.sendMessage(message.key.remoteJid, {
            text: form.finalResponseText,
            buttons: formattedBtns
          });
        } else if (form.finalResponseType === 'link' && form.finalResponseButtons && form.finalResponseButtons.length > 1) {
          await client.sendMessage(message.key.remoteJid, {
            text: form.finalResponseText,
            buttons: [{
              url: form.finalResponseButtons[1],
              text: form.finalResponseButtons[0]
            }]
          });
        } else {
          await client.sendMessage(message.key.remoteJid, { text: form.finalResponseText });
        }
      }
      } catch (e) {
      console.error("Erreur handleResponse master formulaire:", e);
      }
      }
  };
  `;
  }

  compileCatalogToPlugin(catalog) {
    let commands = [];
    const catalogId = catalog._id;
    const userId = catalog.userId;
    const automationId = catalog.automationId;

    commands.push(`{
      name: "cat_main_${catalogId}",
      execute: async (client, message, args, msgOptions) => {
        try {
          if (message.key.remoteJid.endsWith('@g.us')) return;
          const catalogImageUrl = "${catalog.imageUrl || ''}";
          const fs = require('fs');
          const path = require('path');
          const fallbackImage = path.join(process.cwd(), 'ig.jpg');
          
          let msgPayload = {
            buttons: [
              ${catalog.categories.map((c, i) => `{ id: ".cat_${catalogId}_${i}_p0", text: "${c.name.substring(0, 20)}" }`).join(',\n              ')}
            ]
          };

          const textContent = \`🛍️ *${(catalog.name || '').replace(/`/g, '')}*\\n\\n${(catalog.description || '').replace(/`/g, '')}\\n\\nChoisissez une catégorie :\`;

          if (catalogImageUrl) {
            msgPayload.image = { url: catalogImageUrl };
            msgPayload.caption = textContent;
          } else if (fs.existsSync(fallbackImage)) {
            msgPayload.image = { url: fallbackImage };
            msgPayload.caption = textContent;
          } else {
            msgPayload.text = textContent;
          }

          await client.sendMessage(message.key.remoteJid, msgPayload);

          const axios = require('axios');
          const httpUrl = (process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site"));
          const clientNumber = message.key.remoteJid.split('@')[0];
          axios.post(\`\${httpUrl}/schedule-followups\`, {
            userId: process.env.WHATOO_USER_ID,
            automationId: process.env.WHATOO_ID,
            triggerId: "${catalogId}",
            clientNumber: clientNumber
          }).catch(() => {});

        } catch(e) { console.error("Catalog Main Error:", e); }
      }
    }`);

    catalog.categories.forEach((cat, catIdx) => {
      const items = cat.products || [];
      const pageSize = 5;

      for (let i = 0; i < items.length; i += pageSize) {
        const chunk = items.slice(i, i + pageSize);
        const pageIdx = Math.floor(i / pageSize);
        const hasNext = (i + pageSize) < items.length;

        let cards = chunk.map((p, pIdx) => {
           const actualIndex = i + pIdx;
           let buttons = [{ id: `.buy_${catalogId}_${catIdx}_${actualIndex}`, text: "🛒 Acheter", type: "quick_reply" }];
           if (p.paymentLink) {
             buttons.push({ id: "custom_link", text: "🌐 Voir en ligne", type: "url", url: p.paymentLink });
           }

           return {
             title: p.name.substring(0, 20),
             body: `Prix: ${p.price || 0} FCFA\n${p.description || ''}`,
             image: p.imageUrl || "https://dummyimage.com/600x400/000/fff&text=Produit",
             buttons: buttons
           };
        });

        if (hasNext) {
           cards.push({
             title: "Voir plus de produits",
             body: "Cliquez ci-dessous pour voir la suite",
             image: "https://dummyimage.com/600x400/000/fff&text=Plus",
             buttons: [{ id: `.cat_${catalogId}_${catIdx}_p${pageIdx + 1}`, text: "➡️ Suivant", type: "quick_reply" }]
           });
        }

        const safeCatName = (cat.name || "").replace(/"/g, "'");
        const cardsJson = JSON.stringify(cards, null, 2).replace(/`/g, "\\`").replace(/\$/g, "\\$");
        const productsJson = JSON.stringify(chunk.map((p, pIdx) => ({ ...p, originalIndex: i + pIdx })));

        commands.push(`{
          name: "cat_${catalogId}_${catIdx}_p${pageIdx}",
          execute: async (client, message, args, msgOptions) => {
            try {
              if (message.key.remoteJid.endsWith('@g.us')) return;
              
              const isIOS = message.key.id.startsWith('3A');
              
              if (isIOS) {
                const { saveRequest } = require('../../lib/store');
                const { normalizeJid } = require('../../lib/authHelper');
                const senderNum = normalizeJid(message.key.fromMe ? client.user.id : (message.key.participant || message.key.remoteJid));
                
                let listText = "📦 *${safeCatName}*\\n\\nChoisissez un produit en répondant avec son numéro :\\n\\n";
                ${chunk.map((p, pIdx) => {
                  return `listText += "${pIdx + 1}. ${p.name.replace(/"/g, "'")} - ${p.price} FCFA\\n";`;
                }).join('\n                ')}
                ${hasNext ? `listText += "\\n${chunk.length + 1}. ➡️ *Voir la suite (Produits suivants)*\\n";` : ''}
                
                saveRequest(senderNum, message.key.remoteJid, { 
                  command: "cat_${catalogId}_${catIdx}_p${pageIdx}",
                  products: ${productsJson},
                  hasNext: ${hasNext},
                  nextCommand: ".cat_${catalogId}_${catIdx}_p${pageIdx + 1}"
                });
                
                await client.sendMessage(message.key.remoteJid, { text: listText });
                return;
              }

              const StephUI = require('../../lib/stephtech-ui');
              const ui = new StephUI(client);
              const carouselCards = ${cardsJson};
              await ui.carousel(message.key.remoteJid, {
                header: "📦 ${safeCatName}",
                cards: carouselCards
              });
            } catch(e) { console.error("Carousel Error:", e); }
          },
          handleResponse: async (client, message, body, request) => {
            try {
              const index = parseInt(body.trim()) - 1;
              const { deleteRequest } = require('../../lib/store');
              const { normalizeJid } = require('../../lib/authHelper');
              const senderNum = normalizeJid(message.key.fromMe ? client.user.id : (message.key.participant || message.key.remoteJid));

              if (request.hasNext && index === request.products.length) {
                deleteRequest(senderNum, message.key.remoteJid);
                const { messageHandler } = require('../../nexus/handler');
                const fakeM = { 
                   messages: [{
                      key: { ...message.key, fromMe: false },
                      message: { conversation: request.nextCommand },
                      pushName: message.pushName
                   }],
                   type: 'notify'
                };
                await messageHandler(client, fakeM);
                return;
              }

              if (!isNaN(index) && request.products && request.products[index]) {
                const p = request.products[index];
                deleteRequest(senderNum, message.key.remoteJid);
                const StephUI = require('../../lib/stephtech-ui');
                const ui = new StephUI(client);
                
                if (p.stock !== undefined && p.stock !== null && p.stock <= 0) {
                  await client.sendMessage(message.key.remoteJid, { text: \`❌ *\${p.name.replace(/["\`]/g, "'")}* est actuellement en rupture de stock.\` });
                  return;
                }
                
                await ui.buttons(message.key.remoteJid, {
                  text: \`*\${p.name.replace(/["\`]/g, "'")}*\\n\\n\${(p.description || '').replace(/["\`]/g, "'")}\\n\\nPrix: *\${p.price} FCFA*\`,
                  image: p.imageUrl,
                  buttons: [
                    { id: \`.buy_${catalogId}_${catIdx}_\${p.originalIndex}\`, text: "🛒 Acheter" }
                  ]
                });
              }
            } catch(e) { console.error("IOS Fallback Detail Error:", e); }
          }
        }`);

        chunk.forEach((p, pIdx) => {
           const actualIndex = i + pIdx;
           const safeName = p.name.replace(/"/g, "'");
           commands.push(`{
             name: "buy_${catalogId}_${catIdx}_${actualIndex}",
             execute: async (client, message, args, msgOptions) => {
                try {
                  if (message.key.remoteJid.endsWith('@g.us')) return;
                  await client.sendMessage(message.key.remoteJid, { text: "⏳ *Création de votre paiement sécurisé...*" });

                  const httpUrl = (process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL).replace(".cloud", ".site"));
                  const buyerJid = message.key.senderPn || message.key.participantPn || message.key.remoteJid;
                  
                  const axios = require('axios');
                  let resData;
                  try {
                    const payload = {
                       merchantId: "${userId}",
                       automationId: "${automationId}",
                       productId: "${p.id}",
                       productName: "${safeName}",
                       amount: Number(${p.price || 0}),
                       buyerWhatsApp: buyerJid,
                       token: process.env.MASTER_TOKEN
                    };
                    const res = await axios.post(httpUrl + "/initiate-product-payment", payload);
                    resData = res.data;
                  } catch (err) {
                    const errDetail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
                    const errMsg = (err.response && err.response.data && err.response.data.error) ? err.response.data.error : ("Erreur lors de la génération du paiement. Détails: " + errDetail);
                    await client.sendMessage(message.key.remoteJid, { text: "❌ *" + errMsg + "*" });
                    console.error("Axios API error:", errDetail);
                    return;
                  }

                  const data = resData;
                  await client.sendMessage(message.key.remoteJid, {
                    text: \`💳 *Finalisez l'achat de : ${p.name.replace(/'/g, '')}*\\n💰 Montant : *\${data.amount || ${p.price}} FCFA*\\n\\nCliquez sur le bouton ci-dessous pour payer. Une fois le paiement réussi, revenez ici !\`,
                    buttons: [
                      {
                        url: data.link || "https://whatooz.com",
                        text: "🔒 Payer Maintenant"
                      }
                    ]
                  });
                } catch(e) { console.error("Buy button error:", e); }
             }
           }`);
        });
      }
    });

    return `module.exports = [\n${commands.join(',\n')}\n];`;
  }

  async startInstance(whatooId, phoneNumber, client) {
    if (!this.startingLocks) this.startingLocks = new Set();
    if (this.startingLocks.has(whatooId)) {
      console.log(`[LOCK] Démarrage déjà en cours pour ${whatooId}, ignoré pour éviter une boucle.`);
      return;
    }
    this.startingLocks.add(whatooId);

    try {
      // 1. Nettoyage complet : fermer le watcher, supprimer le process PM2
      const processData = this.processes.get(whatooId);
      if (processData && processData.watcher) {
        processData.watcher.close();
      }
      this.processes.delete(whatooId);
      await runPm2(`delete whatoo_${whatooId}`).catch(() => {});

      const mainDir = path.join(__dirname, '..');
      const renDir = path.join(mainDir, 'ren');
      const instancesParent = path.join(mainDir, 'instances');
      const instanceDir = path.join(instancesParent, `whatoo_${whatooId}`);

      if (!fs.existsSync(instancesParent)) {
        fs.mkdirSync(instancesParent, { recursive: true, mode: 0o777 });
      }
      if (!fs.existsSync(instanceDir)) {
        fs.mkdirSync(instanceDir, { recursive: true, mode: 0o777 });
      }

      console.log(`[BOT INIT] Vérification du template master REN dans ${renDir}...`);
      if (!fs.existsSync(renDir)) {
        throw new Error(`Dossier source REN introuvable : ${renDir}`);
      }
      const masterIndex = path.join(renDir, 'index.js');
      if (!fs.existsSync(masterIndex)) {
        throw new Error(`Fichier critique master introuvable : ${masterIndex}`);
      }

      // 1. Clone ren directory
      console.log(`Clonage du bot REN master vers ${instanceDir}...`);
      this.copyFolderRecursive(renDir, instanceDir);

      // Garantir impérativement la présence des fichiers clés (index.js, package.json, config.js)
      const essentialFiles = ['index.js', 'package.json', 'config.js'];
      for (const f of essentialFiles) {
        const srcF = path.join(renDir, f);
        const destF = path.join(instanceDir, f);
        if (fs.existsSync(srcF) && (!fs.existsSync(destF) || fs.statSync(destF).size === 0)) {
          console.log(`[BOT INIT] Copie directe de secours pour ${f} vers ${destF}...`);
          try {
            fs.copyFileSync(srcF, destF);
          } catch (copyErr) {
            console.error(`[BOT INIT] Erreur copie secours ${f}:`, copyErr.message);
          }
        }
      }

      // 2. Symlink node_modules
      const destNodeModules = path.join(instanceDir, 'node_modules');
      let srcNodeModules = path.join(renDir, 'node_modules');
      if (!fs.existsSync(srcNodeModules)) {
        const rootNodeModules = path.join(mainDir, 'node_modules');
        if (fs.existsSync(rootNodeModules)) {
          srcNodeModules = rootNodeModules;
        }
      }

      try {
        if (fs.existsSync(destNodeModules) || fs.lstatSync(destNodeModules).isSymbolicLink()) {
          console.log(`[SYMLINK] Suppression de l'ancien node_modules ou lien mort vers ${destNodeModules}...`);
          fs.rmSync(destNodeModules, { recursive: true, force: true });
        }
      } catch (e) {
        // Ignorer si n'existe pas
      }

      if (fs.existsSync(srcNodeModules)) {
        console.log(`[SYMLINK] Création du lien symbolique node_modules : ${srcNodeModules} -> ${destNodeModules}`);
        try {
          fs.symlinkSync(srcNodeModules, destNodeModules, 'dir');
        } catch (err) {
          console.warn(`[SYMLINK] Avertissement symlink node_modules :`, err.message);
        }
      }

    // 3. Compile responses from Convex
    console.log(`[CONVEX] Chargement des réponses pour Whatoo ${whatooId}...`);
    const responses = await client.query(api.responses.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
    const customPluginDir = path.join(instanceDir, 'plugins', 'custom');
    if (!fs.existsSync(customPluginDir)) {
      fs.mkdirSync(customPluginDir, { recursive: true });
    }

    fs.readdirSync(customPluginDir).forEach(file => {
      if (file.endsWith('.js')) {
        fs.unlinkSync(path.join(customPluginDir, file));
      }
    });

    responses.forEach((rep) => {
      // Map Convex schema to internal plugin compiler schema
      let responseType = rep.responseType || 'text';
      let content = rep.replyText;
      let buttonsStr = undefined;
      
      if (rep.imageUrl) {
        content = JSON.stringify({ text: rep.replyText, image_url: rep.imageUrl });
      }
      
      if (rep.buttons && rep.buttons.length > 0) {
        if (responseType === 'link') {
          buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Visiter', url: rep.buttons[1] || '' }]);
        } else if (responseType === 'contact' || responseType === 'call') {
          buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Appeler', call: rep.buttons[1] || '' }]);
        } else if (responseType === 'copy') {
          buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Copier le texte', copy: rep.buttons[1] || '' }]);
        } else {
          buttonsStr = JSON.stringify(rep.buttons.map((btnStr) => { const parts = btnStr.split("|"); const actionId = parts[0].trim(); const displayText = parts.length > 1 ? parts[1].trim() : actionId; return { id: actionId, text: displayText }; }));
        }
      }

      const mappedRep = {
        id: rep._id,
        keywords: rep.trigger,
        response_type: responseType,
        content: content,
        buttons: buttonsStr
      };

      const code = this.compileResponseToPlugin(mappedRep);
      fs.writeFileSync(path.join(customPluginDir, `cmd_${rep._id}.js`), code);
    });

    // Generate Plugins from Catalogs
    let catalogs = [];
    try {
      catalogs = await client.query(api.catalogs.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
    } catch (e) {
      console.log("[CONVEX] No catalogs table found or error fetching catalogs", e.message);
    }

    catalogs.forEach((cat) => {
      const code = this.compileCatalogToPlugin(cat);
      fs.writeFileSync(path.join(customPluginDir, `catalog_${cat._id}.js`), code);
    });

    // Generate Plugins from Forms
    let forms = [];
    try {
      forms = await client.query(api.forms.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
    } catch (e) {
      console.log("[CONVEX] No forms table found or error fetching forms", e.message);
    }

    if (forms.length > 0) {
      const code = this.compileAllFormsToPlugin(forms);
      fs.writeFileSync(path.join(customPluginDir, `form_master.js`), code);
    }

    // Write raw triggers JSON for triggers handler
    const mappedResponses = responses.map(rep => {
      let responseType = rep.responseType || 'text';
      let content = rep.replyText;
      let buttonsStr = undefined;
      if (rep.imageUrl) {
        content = JSON.stringify({ text: rep.replyText, image_url: rep.imageUrl });
      }
      if (rep.buttons && rep.buttons.length > 0) {
        if (responseType === 'link') {
          buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Visiter', url: rep.buttons[1] || '' }]);
        } else if (responseType === 'contact' || responseType === 'call') {
          buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Appeler', call: rep.buttons[1] || '' }]);
        } else {
          buttonsStr = JSON.stringify(rep.buttons.map((btnStr) => { const parts = btnStr.split("|"); const actionId = parts[0].trim(); const displayText = parts.length > 1 ? parts[1].trim() : actionId; return { id: actionId, text: displayText }; }));
        }
      }
      return {
        id: rep._id,
        keywords: rep.trigger,
        response_type: responseType,
        content: content,
        buttons: buttonsStr,
        destinationGroups: rep.destinationGroups
      };
    });

    // Append catalog triggers mapping
    catalogs.forEach((cat) => {
      mappedResponses.push({
        id: cat._id,
        keywords: cat.trigger,
        response_type: 'cmd_redirect', // Tells triggerHandler.js to execute a specific plugin
        content: `cat_main_${cat._id}`,
        buttons: undefined
      });
    });

    // Forms are handled natively by the 'form' command plugin

    fs.writeFileSync(path.join(instanceDir, 'custom_triggers.json'), JSON.stringify(mappedResponses, null, 2));

    // 4. Generate custom config .env
    const whatoo = await client.query(api.automations.getOne, { id: whatooId, token: process.env.MASTER_TOKEN });
    const currentConvexUrl = process.env.CONVEX_URL;
    const currentImgbbKey = process.env.IMGBB_API_KEY || "254b685aea07ed364f7091dee628d26b";
    const safePhoneNumber = (phoneNumber || "").replace(/[^0-9]/g, '');
    
    const envContent = `BOT_NAME="${whatoo?.name || 'Whatoo Bot'}"
OWNER_NAME="Whatoo Admin"
OWNER_NUMBER="${safePhoneNumber}"
PREFIX="."
SESSION_NAME="session"
WHATOO_ID="${whatooId}"
WHATOO_USER_ID="${whatoo?.userId || ''}"
CONVEX_URL="${currentConvexUrl}"
CONVEX_SITE_URL="${process.env.CONVEX_SITE_URL || ''}"
IMGBB_API_KEY="${currentImgbbKey}"
MASTER_TOKEN="${process.env.MASTER_TOKEN || ''}"
MASTER_PORT="${process.env.PORT || 3000}"
`;
    fs.writeFileSync(path.join(instanceDir, '.env'), envContent);

    // 5. Spawn index.js via PM2
    console.log(`Lancement de l'instance Whatoo ${whatooId} (${whatoo?.name}) via PM2...`);
    
    const isAlreadyConnected = whatoo?.status === 'CONNECTED';
    const statusFile = path.join(instanceDir, 'status.json');

    if (!isAlreadyConnected) {
      this.statusMap.set(whatooId, { status: 'CONNECTING', pairingCode: null });
      
      await client.mutation(api.automations.updateStatus, {
        id: whatooId,
        status: 'CONNECTING',
        token: process.env.MASTER_TOKEN
      });
      fs.writeFileSync(statusFile, JSON.stringify({ status: 'CONNECTING', pairingCode: null }));

      // Supprimer le dossier session uniquement pour forcer un nouveau code de pairage (nouvelle association)
      const sessionDir = path.join(instanceDir, 'session');
      if (fs.existsSync(sessionDir)) {
        console.log(`[SESSION] Nettoyage session pour ${whatooId} avant démarrage (nouvel appairage)...`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
          console.error(`Erreur suppression session ${whatooId}:`, e.message);
        }
      }
    } else {
      // Si déjà connecté, on préserve le statut CONNECTED et on ne supprime pas la session
      console.log(`[SESSION] Instance ${whatooId} déjà connectée. Préservation de la session.`);
      this.statusMap.set(whatooId, { status: 'CONNECTED', pairingCode: null });
      fs.writeFileSync(statusFile, JSON.stringify({ status: 'CONNECTED', pairingCode: null }));
    }

    try {
      // Toujours pm2 delete d'abord (ignore l'erreur si n'existe pas) puis pm2 start
      console.log(`[PM2] Nettoyage ancien processus whatoo_${whatooId}...`);
      await runPm2(`delete whatoo_${whatooId}`).catch(() => {});

      const targetScript = path.join(instanceDir, 'index.js');
      if (!fs.existsSync(targetScript)) {
        throw new Error(`[CRITICAL] Fichier de démarrage introuvable sur le disque : ${targetScript}`);
      }

      console.log(`[PM2] Lancement de "${targetScript}" pour whatoo_${whatooId}...`);
      const { stdout, stderr } = await runPm2(`start "${targetScript}" --name whatoo_${whatooId} --cwd "${instanceDir}"`);
      
      if (stdout) console.log(`[PM2 STDOUT]: ${stdout.trim()}`);
      if (stderr) console.warn(`[PM2 STDERR]: ${stderr.trim()}`);
      
      console.log(`✅ [PM2] whatoo_${whatooId} démarré avec succès.`);
    } catch (err) {
      console.error(`❌ [PM2 ERROR] Échec du démarrage pour whatoo_${whatooId}:`, err.message);
      if (err.stdout) console.error(`[PM2 ERROR STDOUT]: ${err.stdout}`);
      if (err.stderr) console.error(`[PM2 ERROR STDERR]: ${err.stderr}`);
    }

    // Watcher for status.json to get pairing code and connection status
    let debounceTimer = null;
    const watcher = fs.watch(instanceDir, async (eventType, filename) => {
      if (filename === 'status.json') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            if (fs.existsSync(statusFile)) {
              const content = fs.readFileSync(statusFile, 'utf8');
              if (!content) return;
              
              const data = JSON.parse(content);
              const currentInfo = this.statusMap.get(whatooId) || {};
              
              if (data.pairingCode !== currentInfo.pairingCode || data.status !== currentInfo.status) {
                console.log(`[WHATOO ${whatooId} SYNC] Statut: ${data.status}, Code: ${data.pairingCode}`);
                this.statusMap.set(whatooId, { ...currentInfo, ...data });
                await client.mutation(api.automations.updateStatus, {
                  id: whatooId,
                  status: data.status,
                  pairingCode: data.pairingCode || undefined,
                  phoneNumber: phoneNumber,
                  token: process.env.MASTER_TOKEN
                });
              }
            }
          } catch(e) {}
        }, 100);
      }
    });

    this.processes.set(whatooId, { watcher, phoneNumber });
    } finally {
      this.startingLocks.delete(whatooId);
    }
  }

  // Live rebuild and restart on reply trigger modifications
  async rebuildPluginsAndRestart(whatooId, client) {
    const mainDir = path.join(__dirname, '..');
    const customPluginDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`, 'plugins', 'custom');

    if (fs.existsSync(customPluginDir)) {
      console.log(`Mise à jour des fichiers plugins pour Whatoo ${whatooId}...`);
      try {
        fs.readdirSync(customPluginDir).forEach(file => {
          if (file.endsWith('.js')) {
            fs.unlinkSync(path.join(customPluginDir, file));
          }
        });

        const responses = await client.query(api.responses.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
        responses.forEach((rep) => {
          let responseType = rep.responseType || 'text';
          let content = rep.replyText;
          let buttonsStr = undefined;
          
          if (rep.imageUrl) {
            content = JSON.stringify({ text: rep.replyText, image_url: rep.imageUrl });
          }
          
          if (rep.buttons && rep.buttons.length > 0) {
            if (responseType === 'link') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Visiter', url: rep.buttons[1] || '' }]);
            } else if (responseType === 'contact' || responseType === 'call') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Appeler', call: rep.buttons[1] || '' }]);
            } else if (responseType === 'copy') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Copier le texte', copy: rep.buttons[1] || '' }]);
            } else {
              buttonsStr = JSON.stringify(rep.buttons.map((btnStr) => { const parts = btnStr.split("|"); const actionId = parts[0].trim(); const displayText = parts.length > 1 ? parts[1].trim() : actionId; return { id: actionId, text: displayText }; }));
            }
          }

          const mappedRep = {
            id: rep._id,
            keywords: rep.trigger,
            response_type: responseType,
            content: content,
            buttons: buttonsStr
          };

          const code = this.compileResponseToPlugin(mappedRep);
          fs.writeFileSync(path.join(customPluginDir, `cmd_${rep._id}.js`), code);
        });

        // Generate Plugins from Catalogs
        let catalogs = [];
        try {
          catalogs = await client.query(api.catalogs.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
        } catch (e) {
          console.log("[CONVEX] No catalogs table found or error fetching catalogs", e.message);
        }

        catalogs.forEach((cat) => {
          const code = this.compileCatalogToPlugin(cat);
          fs.writeFileSync(path.join(customPluginDir, `catalog_${cat._id}.js`), code);
        });

        // Generate Plugins from Forms
        let forms = [];
        try {
          forms = await client.query(api.forms.listByAutomation, { automationId: whatooId, token: process.env.MASTER_TOKEN });
        } catch (e) {
          console.log("[CONVEX] No forms table found or error fetching forms", e.message);
        }

        if (forms.length > 0) {
          const code = this.compileAllFormsToPlugin(forms);
          fs.writeFileSync(path.join(customPluginDir, `form_master.js`), code);
        }

        // Write custom_triggers.json in real time
        const instanceDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`);
        const mappedResponses = responses.map(rep => {
          let responseType = rep.responseType || 'text';
          let content = rep.replyText;
          let buttonsStr = undefined;
          if (rep.imageUrl) {
            content = JSON.stringify({ text: rep.replyText, image_url: rep.imageUrl });
          }
          if (rep.buttons && rep.buttons.length > 0) {
            if (responseType === 'link') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Visiter', url: rep.buttons[1] || '' }]);
            } else if (responseType === 'contact' || responseType === 'call') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Appeler', call: rep.buttons[1] || '' }]);
            } else if (responseType === 'copy') {
              buttonsStr = JSON.stringify([{ text: rep.buttons[0] || 'Copier le texte', copy: rep.buttons[1] || '' }]);
            } else {
              buttonsStr = JSON.stringify(rep.buttons.map((btnStr) => { const parts = btnStr.split("|"); const actionId = parts[0].trim(); const displayText = parts.length > 1 ? parts[1].trim() : actionId; return { id: actionId, text: displayText }; }));
            }
          }
          return {
            id: rep._id,
            keywords: rep.trigger,
            response_type: responseType,
            content: content,
            buttons: buttonsStr,
            destinationGroups: rep.destinationGroups
          };
        });

        // Append catalog triggers mapping
        catalogs.forEach((cat) => {
          mappedResponses.push({
            id: cat._id,
            keywords: cat.trigger,
            response_type: 'cmd_redirect', // Tells triggerHandler.js to execute a specific plugin
            content: `cat_main_${cat._id}`,
            buttons: undefined
          });
        });

        fs.writeFileSync(path.join(instanceDir, 'custom_triggers.json'), JSON.stringify(mappedResponses, null, 2));

        // Generate AI Context mapping for Gemini
        const aiContext = [];
        responses.forEach(rep => {
           aiContext.push({
              trigger: rep.trigger.split(',')[0].trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ''),
              description: `Action: Envoie un message texte/bouton. Contenu du message: ${rep.replyText.substring(0, 100)}`
           });
        });
        catalogs.forEach(cat => {
           aiContext.push({
              trigger: cat.trigger.split(',')[0].trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ''),
              description: `Action: Affiche le catalogue de produits. Nom du catalogue: ${cat.name || 'Catalogue'}. Description: ${cat.description || ''}`
           });
        });
        fs.writeFileSync(path.join(instanceDir, 'ai_context.json'), JSON.stringify(aiContext, null, 2));

        console.log(`Plugins Whatoo ${whatooId} réécrits avec succès !`);
      } catch (err) {
        console.error(`Erreur réécriture plugins Whatoo ${whatooId}:`, err.message);
      }
    }

    const child = this.processes.get(whatooId);
    if (!child) return; // Not started, nothing else to do

    const envPath = path.join(mainDir, 'instances', `whatoo_${whatooId}`, '.env');
    let phoneNumber = '';
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/OWNER_NUMBER="([^"]+)"/);
      if (match) phoneNumber = match[1];
    }

    if (phoneNumber) {
      console.log(`Redémarrage de l'instance Whatoo ${whatooId} suite à la modification des commandes...`);
      await this.startInstance(whatooId, phoneNumber, client);
    }
  }

  async stopInstance(whatooId, client, isFinalDeletion = false) {
    const processData = this.processes.get(whatooId);
    if (processData && processData.watcher) {
      processData.watcher.close();
    }
    this.processes.delete(whatooId);

    const mainDir = path.join(__dirname, '..');
    const instanceDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`);

    if (isFinalDeletion) {
      console.log(`[PM2] Suppression définitive de l'instance Whatoo ${whatooId}...`);
      await runPm2(`delete whatoo_${whatooId}`).catch(() => {});

      // Attendre 1.5s pour que PM2 libère complètement les fichiers verrouillés
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Supprimer tout le dossier instance
      if (fs.existsSync(instanceDir)) {
        try {
          fs.rmSync(instanceDir, { recursive: true, force: true });
          console.log(`[FS] Dossier de l'instance ${whatooId} supprimé.`);
        } catch (e) {
          console.error(`Erreur suppression dossier instance ${whatooId}:`, e.message);
        }
      }
    } else {
      console.log(`[PM2] Arrêt de l'instance Whatoo ${whatooId}...`);
      await runPm2(`stop whatoo_${whatooId}`).catch(() => {});

      // Attendre 1s pour que PM2 libère les verrous de fichiers
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Nettoyer le dossier session pour forcer un nouveau pairage à la réactivation
      const sessionDir = path.join(instanceDir, 'session');
      if (fs.existsSync(sessionDir)) {
        console.log(`[SESSION] Nettoyage session pour ${whatooId} (désactivation)...`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
          console.error(`Erreur suppression session ${whatooId}:`, e.message);
        }
      }
    }

    this.statusMap.set(whatooId, { status: 'DISCONNECTED', pairingCode: null });

    if (client) {
      await client.mutation(api.automations.updateStatus, {
        id: whatooId,
        status: 'DISCONNECTED',
        pairingCode: undefined,
        token: process.env.MASTER_TOKEN
      }).catch(e => {
        if (!e.message?.includes("introuvable")) {
          console.error("Error setting disconnected state in Convex:", e.message);
        }
      });
    }
  }

  async logoutInstance(whatooId, client) {
    // 1. Stop and Delete the PM2 process to ensure session files are not locked
    console.log(`[LOGOUT] Arrêt et suppression PM2 pour ${whatooId} avant nettoyage session...`);
    await runPm2(`delete whatoo_${whatooId}`).catch(() => {});

    // Attendre 1.5s pour que PM2 libère complètement les fichiers
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 2. Clear internal tracking
    const processData = this.processes.get(whatooId);
    if (processData && processData.watcher) {
      processData.watcher.close();
      this.processes.delete(whatooId);
    }

    // 3. Delete the session folder
    const mainDir = path.join(__dirname, '..');
    const sessionDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`, 'session');
    if (fs.existsSync(sessionDir)) {
      console.log(`[LOGOUT] Nettoyage du dossier session pour ${whatooId}...`);
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Impossible de supprimer la session ${whatooId}:`, err.message);
      }
    }

    this.statusMap.set(whatooId, { status: 'DISCONNECTED', pairingCode: null });

    if (client) {
      await client.mutation(api.automations.updateStatus, {
        id: whatooId,
        status: 'DISCONNECTED',
        pairingCode: undefined,
        token: process.env.MASTER_TOKEN
      }).catch(e => console.error("Error setting disconnected state in Convex:", e));
    }
  }

  rebuildGroupSettings(whatooId, groupSettings) {
    const mainDir = path.join(__dirname, '..');
    const instanceDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`);
    const dbDir = path.join(instanceDir, 'database');
    const groupsFile = path.join(dbDir, 'groups.json');
    
    if (!fs.existsSync(instanceDir)) return;
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (err) {}
    }

    const groupsData = {};
    for (const s of (groupSettings || [])) {
      groupsData[s.groupId] = {
        antilink: s.antilink || false,
        antilinkAction: s.antilinkAction || 'delete',
        antispam: s.antispam || false,
        antitransfert: s.antitransfert || false,
        antimedia: s.antimedia || false,
        antitag: s.antitag || false,
        antipromote: s.antipromote || false,
        antidemote: s.antidemote || false,
        antibadword: s.antibadword || false,
        badwords: s.badwords || [],
        autoreact: s.autoreact || false,
        welcome: s.welcome || false,
        welcomeMessage: s.welcomeMessage || "Bienvenue @user dans @group !\n\nDescription :\n@desc"
      };
    }

    try {
      fs.writeFileSync(groupsFile, JSON.stringify(groupsData, null, 2));
      console.log(`[SYNC GROUPS] Local groups.json updated for bot ${whatooId}`);
    } catch (err) {
      console.error(`[SYNC GROUPS] Error writing groups.json for bot ${whatooId}:`, err.message);
    }
  }

  queuePostPurchaseMessage(whatooId, buyerWhatsApp, message, responseType, buttons, imageUrl = undefined, delayMs = 0) {
    const mainDir = path.join(__dirname, '..');
    const instanceDir = path.join(mainDir, 'instances', `whatoo_${whatooId}`);
    const queueDir = path.join(instanceDir, 'message_queue');
    
    if (!fs.existsSync(instanceDir)) return;
    if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });

    const msgFile = {
      to: buyerWhatsApp.includes('@') ? buyerWhatsApp : `${buyerWhatsApp}@s.whatsapp.net`,
      text: message,
      responseType: responseType || 'text',
      buttons: buttons || [],
      imageUrl: imageUrl || undefined,
      timestamp: Date.now() + delayMs
    };

    const fileName = `msg_${Date.now() + delayMs}_${Math.random().toString(36).substring(2, 8)}.json`;
    fs.writeFileSync(path.join(queueDir, fileName), JSON.stringify(msgFile, null, 2));
    console.log(`[QUEUE] Message en file d'attente pour ${buyerWhatsApp} (différé de ${delayMs}ms) dans l'instance ${whatooId}`);
  }
}

export const whatsappManager = new WhatsAppInstanceManager();
