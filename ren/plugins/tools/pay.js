const axios = require('axios');
const path = require('path');

module.exports = {
  name: 'pay',
  aliases: ['payer', 'paiement'],
  category: 'tools',
  desc: 'Créer un lien de paiement SasPay avec bouton',
  usage: '.pay <montant> ou pay <montant>',
  allowNoPrefix: true, // Autorise l'exécution sans préfixe (ex: pay 1500)
  isPublic: true,     // Accessible en groupe et en DM

  execute: async (client, message, args, msgOptions) => {
    try {
      // 1. Syntaxe stricte anti-spam : l'utilisateur doit spécifier un montant numérique (ex: pay 1500 ou .pay 1500)
      // Si l'utilisateur tape juste "pay" sans montant ou du texte, on ne fait STRICTEMENT RIEN pour éviter tout spam
      if (!args || args.length === 0) return;

      const rawAmount = args[0].replace(/[^0-9]/g, '');
      const amount = parseInt(rawAmount, 10);
      if (!amount || isNaN(amount) || amount <= 0) return;

      const jid = message.key.remoteJid;
      const rawBuyer = message.key.participantPn || message.key.senderPn || message.key.participant || jid;
      let cleanPhone = String(rawBuyer || '').split('@')[0].replace(/\D/g, '');
      if (!cleanPhone || cleanPhone.length < 7) cleanPhone = '237600000000';

      console.log(`[PAY PLUGIN] 💳 Commande reçue : ${amount} FCFA pour ${cleanPhone} dans ${jid}`);

      // Réaction d'attente
      await client.sendMessage(jid, { react: { text: "⏳", key: message.key } }).catch(() => {});

      const httpUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL ? process.env.CONVEX_URL.replace(".cloud", ".site") : "https://incredible-hummingbird-86.convex.site");
      const automationId = process.env.WHATOO_ID || path.basename(process.cwd()).replace('whatoo_', '');
      const token = process.env.MASTER_TOKEN;

      const payload = {
        merchantId: process.env.WHATOO_USER_ID,
        automationId: automationId,
        isGeneric: true,
        amount: amount,
        buyerWhatsApp: cleanPhone,
        token: token
      };

      console.log(`[PAY PLUGIN] Appel API /initiate-product-payment...`);
      const res = await axios.post(`${httpUrl}/initiate-product-payment`, payload, { timeout: 15000 });
      const data = res.data;

      if (!data || !data.link) {
        console.error("[PAY PLUGIN] ❌ Aucun lien de paiement reçu:", data);
        await client.sendMessage(jid, { react: { text: "❌", key: message.key } }).catch(() => {});
        return;
      }

      const checkoutLink = data.link;

      // Réaction de succès
      await client.sendMessage(jid, { react: { text: "💳", key: message.key } }).catch(() => {});

      // Message clair avec lien cliquable en texte brut + bouton URL
      const payText = `💳 *Demande de Paiement*\n` +
                      `💰 *Montant :* ${amount.toLocaleString('fr-FR')} FCFA\n\n` +
                      `Veuillez payer *${amount.toLocaleString('fr-FR')} FCFA* en cliquant sur le bouton ci-dessous :\n` +
                      `🔗 ${checkoutLink}\n\n` +
                      `_Le solde du portefeuille Whatooz sera crédité dès la validation du paiement._`;

      try {
        await client.sendMessage(jid, {
          text: payText,
          footer: "Whatooz Pay",
          buttons: [
            {
              url: checkoutLink,
              text: "💳 Payer Maintenant"
            }
          ]
        }, { quoted: message, ...(msgOptions || {}) });
      } catch (btnErr) {
        console.warn("[PAY PLUGIN] Repli sur message texte simple:", btnErr.message);
        await client.sendMessage(jid, { text: payText }, { quoted: message, ...(msgOptions || {}) });
      }

      console.log(`[PAY PLUGIN] ✅ Lien de paiement envoyé avec succès dans ${jid} !`);

    } catch (err) {
      console.error("[PAY PLUGIN] Erreur lors de la création du paiement:", err.message);
      if (err.response && err.response.data) {
        console.error("[PAY PLUGIN] Détails:", err.response.data);
      }
      await client.sendMessage(message.key.remoteJid, { react: { text: "❌", key: message.key } }).catch(() => {});
    }
  }
};
