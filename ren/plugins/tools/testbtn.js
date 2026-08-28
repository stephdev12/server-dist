module.exports = {
    name: 'testbtn',
    category: 'tools',
    desc: 'Teste tous les types de boutons interactifs natifs de WhatsApp',
    execute: async (client, message, args) => {
        const jid = message.key.remoteJid;
        const isIOS = message.key.id && message.key.id.length === 32 && message.key.id.startsWith('3A');

        if (isIOS) {
            await client.sendMessage(jid, {
                text: "🍎 Détection iOS : Vous êtes sur iPhone (ou l'ID du message commence par 3A). Les boutons interactifs et carrousels ne s'affichent pas nativement sur iOS, nous utilisons donc cette vue texte en liste (Fallback) :\n\n- Option 1\n- Option 2\n- 🔗 Visiter Whatooz: https://whatooz.com\n- 📋 Copier Promo: WHATOOZ2026\n\n(Sur Android/Web, vous verriez des boutons stylisés ou un Carrousel natif !)"
            });
            return;
        }

        // 1. Test des boutons avec du texte
        await client.sendMessage(jid, {
            text: "Voici un test de tous les types de boutons interactifs supportés par notre nouveau fork Baileys ! 🚀",
            footer: "Whatooz Interactive Test",
            buttons: [
                { id: "btn_yes", text: "✅ Oui" },
                { id: "btn_no", text: "❌ Non" },
                { url: "https://whatooz.com", text: "🔗 Visiter Whatooz" },
                { call: "+1234567890", text: "📞 Appeler" },
                { copy: "WHATOOZ2026", text: "📋 Copier Promo" }
            ]
        });

        // 2. Test des boutons avec un en-tête média (image)
        await client.sendMessage(jid, {
            caption: "Et voici un test de boutons avec une image attachée ! 🖼️",
            footer: "Whatooz Media Test",
            image: { url: "https://picsum.photos/400/200" },
            buttons: [
                { id: "img_btn", text: "C'est magnifique ! 🌟" },
                { url: "https://whatooz.com", text: "Voir plus" }
            ]
        });
        // 3. Test du Carousel
        const StephUI = require('../../lib/stephtech-ui');
        const ui = new StephUI(client);
        await ui.carousel(jid, {
            header: "Ceci est un Carrousel interactif 🎠",
            cards: [
                {
                    title: "Card 1", body: "Contenu de la carte 1",
                    buttons: [
                        { id: "c1_btn1", text: "Choisir 1" },
                        { url: "https://whatooz.com", text: "Lien 1" }
                    ]
                },
                {
                    title: "Card 2", body: "Contenu de la carte 2",
                    buttons: [
                        { id: "c2_btn1", text: "Choisir 2" },
                        { copy: "CAROUSEL_CODE", text: "Copier Code" }
                    ]
                }
            ]
        });
    }
};
