const axios = require('axios');

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
      // 1. Syntaxe stricte anti-spam : l'utilisateur doit spécifier un montant (ex: pay 1500 ou .pay 1500)
      // Si l'utilisateur tape juste "pay" sans montant ou avec un texte non numérique, on ne fait STRICTEMENT RIEN pour éviter tout spam
      if (!args || args.length === 0) return;

      const rawAmount = args[0].replace(/[^0-9]/g, '');
      const amount = parseInt(rawAmount, 10);
      if (!amount || isNaN(amount) || amount <= 0) return;

      const jid = message.key.remoteJid;

      // Réaction d'attente
      await client.sendMessage(jid, { react: { text: "⏳", key: message.key } }).catch(() => {});

      const httpUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL ? process.env.CONVEX_URL.replace(".cloud", ".site") : null);
      if (!httpUrl) {
        console.error("[PAY PLUGIN] CONVEX_SITE_URL ou CONVEX_URL manquant dans l'environnement.");
        await client.sendMessage(jid, { react: { text: "❌", key: message.key } }).catch(() => {});
        return;
      }

      // Détection de l'acheteur (expéditeur du message, que ce soit en groupe ou en privé)
      const buyerJid = message.key.senderPn || message.key.participantPn || message.key.participant || jid;
      const cleanPhone = String(buyerJid).replace(/\D/g, "");

      const payload = {
        merchantId: process.env.WHATOO_USER_ID,
        automationId: process.env.WHATOO_ID,
        isGeneric: true,
        amount: amount,
        buyerWhatsApp: cleanPhone,
        token: process.env.MASTER_TOKEN
      };

      console.log(`[PAY PLUGIN] Génération de paiement de ${amount} FCFA pour ${cleanPhone}...`);
      const res = await axios.post(`${httpUrl}/initiate-product-payment`, payload, { timeout: 15000 });
      const data = res.data;

      if (!data || !data.link) {
        console.error("[PAY PLUGIN] Réponse invalide de l'API:", data);
        await client.sendMessage(jid, { react: { text: "❌", key: message.key } }).catch(() => {});
        return;
      }

      const checkoutLink = data.link;

      // Réaction de succès
      await client.sendMessage(jid, { react: { text: "💳", key: message.key } }).catch(() => {});

      // Message clair avec bouton interactif URL + lien cliquable en texte brut
      const payText = `💳 *Demande de Paiement*\n` +
                      `💰 *Montant :* ${amount.toLocaleString('fr-FR')} FCFA\n\n` +
                      `Veuillez payer *${amount.toLocaleString('fr-FR')} FCFA* en cliquant sur le bouton ci-dessous :\n` +
                      `🔗 ${checkoutLink}\n\n` +
                      `_Le solde du portefeuille Whatooz sera crédité dès la validation du paiement._`;

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

    } catch (err) {
      console.error("[PAY PLUGIN] Erreur lors de la création du paiement:", err.message);
      if (err.response && err.response.data) {
        console.error("[PAY PLUGIN] Détails:", err.response.data);
      }
      await client.sendMessage(message.key.remoteJid, { react: { text: "❌", key: message.key } }).catch(() => {});
    }
  }
};
