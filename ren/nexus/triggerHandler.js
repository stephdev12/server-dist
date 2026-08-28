// 🎯 NEXUS - WHATOO KEYWORD TRIGGER HANDLER
const fs = require('fs');
const path = require('path');

async function handleKeywordTriggers(sock, msg, overrideBody = null) {
  try {
    const chatId = msg.key.remoteJid;

    // Éviter que le bot réponde dans les groupes pour les réponses automatiques Whatoo (@g.us)
    if (chatId.endsWith('@g.us')) return false;

    // Unpack viewOnceMessage / viewOnceMessageV2
    let msgType = Object.keys(msg.message || {})[0];
    let innerMessage = msg.message;
    if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
        innerMessage = msg.message[msgType].message;
    }

    let body = overrideBody || innerMessage?.conversation || 
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
                 
    if (!body || (msg.key.fromMe && !overrideBody)) return false;

    const triggersPath = path.join(__dirname, '../custom_triggers.json');
    if (!fs.existsSync(triggersPath)) return false;

    const triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
    const bodyLower = body.toLowerCase().trim();

    for (const trigger of triggers) {
      const keywords = Array.isArray(trigger.keywords) 
        ? trigger.keywords 
        : trigger.keywords.split(',').map(k => k.trim());

      let matchedKeyword = "";
      const match = keywords.some(kw => {
        const kwLower = kw.toLowerCase().trim();
        
        // Nouvelle logique: on accepte si le message contient le mot clé n'importe où
        const matches = bodyLower.includes(kwLower);
        
        if (matches) matchedKeyword = kw;
        return matches;
      });

      if (match) {
        console.log(`[WHATOO TRIGGER] Déclencheur détecté pour "${body}":`, keywords);
        await sendResponse(sock, chatId, trigger, msg);

        // --- TRANSFERT DU MESSAGE VERS LES GROUPES CONFIGURÉS ---
        if (trigger.destinationGroups && Array.isArray(trigger.destinationGroups) && trigger.destinationGroups.length > 0) {
            try {
                const senderNum = msg.key.remoteJid;
                let formattedMsg = `> tel : @${senderNum.split('@')[0]}\n`;
                formattedMsg += `> messages : ${body}`;
                
                for (const groupJid of trigger.destinationGroups) {
                    await sock.sendMessage(groupJid, {
                        text: formattedMsg,
                        mentions: [senderNum]
                    });
                    console.log(`[TRIGGER ROUTING] Message transféré au groupe ${groupJid}`);
                }
            } catch (routingErr) {
                console.error("❌ [TRIGGER ROUTING] Erreur lors du transfert du message:", routingErr.message);
            }
        }

        // --- ENREGISTRER L'INTERACTION DU PROSPECT EN BD ---
        try {
            const path = require('path');
            const pathParts = process.cwd().split(path.sep);
            const folderName = pathParts[pathParts.length - 1];
            const whatooId = folderName.replace('whatoo_', '') || process.env.WHATOO_ID;
            const httpUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL || '').replace(".cloud", ".site");
            const senderNum = msg.key.remoteJid;
            
            const axios = require('axios');
            await axios.post(`${httpUrl}/register-interaction`, {
                userId: process.env.WHATOO_USER_ID,
                automationId: whatooId,
                clientNumber: senderNum,
                clientName: msg.pushName || undefined,
                interactionType: trigger.response_type === 'cmd_redirect' ? 'catalog' : 'trigger'
            }).catch(() => {});
        } catch (e) {
            console.error("Erreur enregistrement prospect:", e.message);
        }
        
        // APPELER L'API MASTER POUR ENREGISTRER L'ACTIVITÉ EN DIRECT
        try {
          const pathParts = process.cwd().split(path.sep);
          const folderName = pathParts[pathParts.length - 1]; // whatoo_1
          const whatooId = folderName.replace('whatoo_', '');
          
          // Utilisation du fetch global natif de Node.js 18+
          if (global.fetch) {
            const localPort = process.env.MASTER_PORT || process.env.PORT || 3000;
            await global.fetch(`http://localhost:${localPort}/api/activities/log`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                category: 'whatsapp',
                title: 'Réponse envoyée',
                description: `Réponse automatique envoyée pour le déclencheur "${matchedKeyword}" à ${chatId.split('@')[0]}.`
              })
            });
          }
        } catch (e) {
          console.error("Erreur log activity master:", e);
        }
        
        return true; // Match trouvé et traité
      }
    }
  } catch (err) {
    console.error("Erreur lors de la détection de déclencheur Whatoo:", err);
  }
  return false;
}

async function sendResponse(sock, jid, response, quotedMsg) {
  const { response_type, content, buttons } = response;

  let text = content;
  let imageUrl = "";

  // Détecter si le contenu est sérialisé en JSON (contenant un texte + image facultative)
  if (typeof content === 'string' && content.startsWith('{') && content.endsWith('}')) {
    try {
      const parsed = JSON.parse(content);
      text = parsed.text || "";
      imageUrl = parsed.image_url || "";
    } catch (e) {
      text = content;
    }
  }

  // Si une image est présente et que ce n'est pas un message interactif supporté avec header, on envoie séparément
  if (imageUrl && !['text', 'buttons', 'link', 'copy'].includes(response_type)) {
    try {
      await sock.sendMessage(jid, { image: { url: imageUrl } }, { quoted: quotedMsg });
    } catch (e) {
      console.error("Erreur d'envoi de l'image attachée:", e);
    }
  }

  // Détection d'iOS (Fallback pour Interactive Messages)
  const isIOS = quotedMsg?.key?.id && quotedMsg.key.id.length === 32 && quotedMsg.key.id.startsWith('3A');

  switch (response_type) {
    case 'cmd_redirect': {
      // Pour les catalogues E-commerce : On délègue l'exécution au plugin (ex: cat_main_ID)
      if (content.startsWith('cat_main_')) {
        const catalogId = content.replace('cat_main_', '');
        const pluginPath = path.join(__dirname, '../plugins/custom', `catalog_${catalogId}.js`);
        if (fs.existsSync(pluginPath)) {
          const pluginModule = require(pluginPath);
          const plugin = Array.isArray(pluginModule) ? pluginModule.find(p => p.name === content) : pluginModule;
          if (plugin && plugin.execute) {
            await plugin.execute(sock, quotedMsg, [], {});
          }
        }
      }
      break;
    }

    case 'text':
      if (imageUrl) {
        await sock.sendMessage(jid, { image: { url: imageUrl }, caption: text }, { quoted: quotedMsg });
      } else {
        await sock.sendMessage(jid, { text: text }, { quoted: quotedMsg });
      }
      break;

    case 'buttons': {
      let parsedButtons = [];
      try {
        parsedButtons = typeof buttons === 'string' ? JSON.parse(buttons) : (buttons || []);
      } catch (e) {}

      if (isIOS) {
        let fallbackText = text + "\n\nOptions :";
        parsedButtons.forEach((btn, idx) => fallbackText += `\n- ${btn.text}`);
        await sock.sendMessage(jid, { text: fallbackText }, { quoted: quotedMsg });
        break;
      }

      const StephUI = require('../lib/stephtech-ui');
      const ui = new StephUI(sock);
      await ui.buttons(jid, {
        text: text,
        image: imageUrl || null,
        buttons: parsedButtons.map((btn, idx) => ({
          id: btn.id || `btn_${idx}`,
          text: btn.text
        }))
      });
      break;
    }

    case 'link': {
      let parsedButtons = [];
      try {
        parsedButtons = typeof buttons === 'string' ? JSON.parse(buttons) : (buttons || []);
      } catch (e) {}
      
      const linkUrl = parsedButtons[0]?.url || '';
      const linkText = parsedButtons[0]?.text || 'Visiter';

      if (isIOS) {
        await sock.sendMessage(jid, { text: `${text}\n\n🔗 ${linkText}: ${linkUrl}` }, { quoted: quotedMsg });
        break;
      }

      const StephUI = require('../lib/stephtech-ui');
      const ui = new StephUI(sock);
      await ui.buttons(jid, {
        text: text,
        image: imageUrl || null,
        buttons: [
          { text: linkText, url: linkUrl }
        ]
      });
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

      await sock.sendMessage(jid, {
        location: {
          degreesLatitude: lat,
          degreesLongitude: lng,
          name: name
        }
      }, { quoted: quotedMsg });
      break;
    }

    case 'contact':
    case 'call': {
      let parsedButtons = [];
      try {
        parsedButtons = typeof buttons === 'string' ? JSON.parse(buttons) : (buttons || []);
      } catch (e) {}
      
      const callPhone = parsedButtons[0]?.call || '';
      const callText = parsedButtons[0]?.text || 'Appeler';

      if (isIOS) {
        await sock.sendMessage(jid, { text: `${text}\n\n📞 ${callText}: ${callPhone}` }, { quoted: quotedMsg });
        break;
      }

      const StephUI = require('../lib/stephtech-ui');
      const ui = new StephUI(sock);
      await ui.buttons(jid, {
        text: text,
        image: imageUrl || null,
        buttons: [
          { text: callText, call: callPhone }
        ]
      });
      break;
    }

    case 'copy': {
      let parsedButtons = [];
      try {
        parsedButtons = typeof buttons === 'string' ? JSON.parse(buttons) : (buttons || []);
      } catch (e) {}

      const copyText = parsedButtons[0]?.text || 'Copier le texte';
      const copyCode = parsedButtons[0]?.copy || text;

      if (isIOS) {
        await sock.sendMessage(jid, { text: `${text}\n\n📋 *Code à copier:* ${copyCode}` }, { quoted: quotedMsg });
        break;
      }

      const StephUI = require('../lib/stephtech-ui');
      const ui = new StephUI(sock);
      await ui.buttons(jid, {
        text: text,
        image: imageUrl || null,
        buttons: [
          { text: copyText, copy: copyCode }
        ]
      });
      break;
    }



    case 'image': {
      let imageUrlStr = "";
      let captionText = "";
      try {
        const imgData = JSON.parse(content);
        imageUrlStr = imgData.image_url || "";
        captionText = imgData.caption || "";
      } catch (e) {
        imageUrlStr = content;
      }

      if (imageUrlStr) {
        await sock.sendMessage(jid, { 
          image: { url: imageUrlStr }, 
          caption: captionText 
        }, { quoted: quotedMsg });
      }
      break;
    }

    default:
      await sock.sendMessage(jid, { text: content }, { quoted: quotedMsg });
  }
}

module.exports = { handleKeywordTriggers };
