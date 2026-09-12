// 💳 WHATOOZ - GESTIONNAIRE DE COMMANDE UNIVERSELLE DE PAIEMENT RAPIDE (pay <montant>)
const axios = require('axios');
const path = require('path');

/**
 * Traite la commande universelle de paiement 'pay <montant>'.
 * Fonctionne en messages privés ET dans les groupes WhatsApp (@g.us).
 * Syntaxe stricte : 'pay 1500', '.pay 2000', 'pay 5000 FCFA'.
 * Si l'utilisateur tape juste 'pay' ou un texte sans montant, retourne false (anti-spam).
 */
async function handleUniversalPayCommand(sock, msg) {
  try {
    if (!msg || !msg.message) return false;

    // Déballer les messages éphémères / viewOnce
    let msgType = Object.keys(msg.message)[0];
    let innerMessage = msg.message;
    if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
      innerMessage = msg.message[msgType].message;
    }

    // Extraction du texte brut
    const body = innerMessage?.conversation ||
                 innerMessage?.extendedTextMessage?.text ||
                 innerMessage?.imageMessage?.caption ||
                 innerMessage?.buttonsResponseMessage?.selectedButtonId ||
                 innerMessage?.templateButtonReplyMessage?.selectedId ||
                 innerMessage?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 "";

    if (!body || typeof body !== 'string') return false;

    // 🔒 VÉRIFICATION SYNTAXE STRICTE : 'pay 1500', '.pay 2000', 'pay 5000 fcfa'
    // Doit impérativement comporter un montant numérique
    const payRegex = /^\.?pay\s+(\d+)(?:\s*(?:fcfa|cfa|f))?$/i;
    const match = body.trim().match(payRegex);

    if (!match) {
      // Pas de match strict (ex: juste 'pay', 'paye', 'payment') -> ignorer silencieusement pour éviter tout spam
      return false;
    }

    const amount = parseInt(match[1], 10);
    // Montant minimum de 100 FCFA requis pour les transactions mobiles
    if (isNaN(amount) || amount < 100) {
      return false;
    }

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const rawPhone = String(sender || chatId || '').split('@')[0].replace(/\D/g, '');
    const buyerPhone = rawPhone.length >= 8 ? rawPhone : '237600000000';

    console.log(`[PAY COMMAND] 🎯 Commande détectée : ${amount} FCFA par ${buyerPhone} (Chat: ${chatId}, Groupe: ${isGroup})`);

    const convexUrl = process.env.CONVEX_URL;
    const masterToken = process.env.MASTER_TOKEN;
    const automationId = process.env.WHATOO_ID || path.basename(path.resolve(__dirname, '../')).replace('whatoo_', '');
    const userId = process.env.WHATOO_USER_ID;

    if (!convexUrl || !masterToken || !userId) {
      console.error('[PAY COMMAND] ❌ Configuration manquante dans l\'instance (CONVEX_URL, MASTER_TOKEN ou WHATOO_USER_ID).');
      return false;
    }

    const httpUrl = process.env.CONVEX_SITE_URL || convexUrl.replace('.cloud', '.site');

    // Mettre l'état en écriture
    await sock.sendPresenceUpdate('composing', chatId).catch(() => {});

    // Appel à l'endpoint de génération de lien de paiement direct SasPay
    const response = await axios.post(`${httpUrl}/initiate-product-payment`, {
      token: masterToken,
      userId: userId,
      automationId: automationId,
      productId: 'generic_pay_cmd',
      productName: `Paiement (${amount.toLocaleString('fr-FR')} FCFA)`,
      amount: amount,
      buyerWhatsApp: buyerPhone,
      isGeneric: true,
    }, {
      timeout: 15000
    });

    const data = response.data;
    const checkoutLink = data?.link;

    if (!checkoutLink) {
      console.error('[PAY COMMAND] ❌ Aucun lien de paiement reçu de SasPay:', data);
      await sock.sendMessage(chatId, {
        text: "❌ Impossible d'initialiser le paiement sécurisé SasPay pour le moment. Veuillez réessayer."
      }, { quoted: msg }).catch(() => {});
      return true;
    }

    const formattedAmount = amount.toLocaleString('fr-FR');
    const messageText = `💳 *Demande de Paiement SasPay*\n\nVeuillez régler la somme de *${formattedAmount} FCFA* en toute sécurité en cliquant sur le bouton ci-dessous :\n\n🔗 ${checkoutLink}\n\n_Une fois le paiement effectué, le portefeuille Whatooz sera instantanément crédité._`;

    // 1. Tenter d'envoyer avec bouton interactif URL
    let buttonSent = false;
    try {
      const StephUI = require('../lib/stephtech-ui');
      const ui = new StephUI(sock);
      await ui.buttons(chatId, {
        text: messageText,
        buttons: [
          { id: "saspay_url_btn", text: `💳 Payer ${formattedAmount} FCFA`, type: "url", url: checkoutLink }
        ]
      });
      buttonSent = true;
      console.log(`[PAY COMMAND] ✅ Bouton de paiement interactif envoyé à ${chatId}`);
    } catch (btnErr) {
      console.warn('[PAY COMMAND] ⚠️ Bouton interactif refusé, envoi en message texte sécurisé:', btnErr.message);
    }

    // 2. Si les boutons sont refusés (ex: certains groupes ou clients spécifiques), envoyer le message texte direct
    if (!buttonSent) {
      await sock.sendMessage(chatId, {
        text: messageText
      }, { quoted: msg }).catch(() => {});
      console.log(`[PAY COMMAND] ✅ Message texte avec lien direct envoyé à ${chatId}`);
    }

    await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
    return true; // Action traitée avec succès
  } catch (err) {
    console.error('[PAY COMMAND Error]:', err.message || err);
    return false;
  }
}

module.exports = { handleUniversalPayCommand };
