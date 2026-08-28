// 🌉 GROUP STATUS BRIDGE — Singleton optimisé pour petits serveurs
// Utilise baileys-new/gcstatus UNIQUEMENT pour générer le proto groupStatusMessageV2
// mais se branche sur le socket Baileys standard déjà ouvert (pas de 2e connexion WA).

let _giftedStatusInstance = null;
let _GiftedStatusClass = null;

/**
 * Initialise le bridge avec le socket Baileys standard.
 * À appeler UNE seule fois au 'connection.update' open.
 * @param {object} sock — socket Baileys standard (makeWASocket)
 */
async function initGroupStatusBridge(sock) {
    if (_giftedStatusInstance) return; // déjà initialisé

    try {
        if (!_GiftedStatusClass) {
            // Supporte à la fois le package node_modules et le dossier local baileys-new
            let mod;
            try {
                mod = await import('baileys-new/lib/Socket/gcstatus.js');
            } catch (e) {
                try {
                    mod = await import('../baileys-new/lib/Socket/gcstatus.js');
                } catch (e2) {
                    mod = await import('../../ren/baileys-new/lib/Socket/gcstatus.js');
                }
            }
            _GiftedStatusClass = mod.default || mod;
        }

        _giftedStatusInstance = new _GiftedStatusClass(
            {},                               // utils (non utilisé)
            sock.waUploadToServer,            // upload des médias via baileys standard
            sock.relayMessage.bind(sock),     // relay via baileys standard
            { logger: sock.logger },          // config minimale
            sock                              // sock complet (pour groupMetadata, etc.)
        );

        // Expose sur le socket pour compatibilité avec gifted-baileys / baileys-new
        sock.giftedStatus = _giftedStatusInstance;

        // Monkey-patch sendMessage pour intercepter groupStatusMessage
        const originalSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options = {}) => {
            if (typeof content === 'object' && content.groupStatusMessage) {
                return await _giftedStatusInstance.handleGroupStory(content, jid, options.quoted);
            }
            return await originalSendMessage(jid, content, options);
        };

        console.log('[GroupStatusBridge] ✅ Initialisé et socket patché avec succès (API compatible baileys-new)');
    } catch (err) {
        console.error('[GroupStatusBridge] ❌ Erreur initialisation:', err.message);
        _giftedStatusInstance = null;
    }
}

/**
 * Réinitialise le bridge (utile lors d'une reconnexion).
 */
function resetGroupStatusBridge() {
    _giftedStatusInstance = null;
    console.log('[GroupStatusBridge] 🔄 Reset (reconnexion détectée)');
}

/**
 * Envoie un statut de groupe.
 * @param {string} groupJid — JID du groupe cible (ex: 1234567890@g.us)
 * @param {object} content — { text?, image?, caption?, backgroundColor?, font? }
 * @returns {Promise<boolean>} true si succès
 */
async function sendGroupStatus(groupJid, content) {
    if (!_giftedStatusInstance) {
        console.warn('[GroupStatusBridge] ⚠️ Bridge non initialisé. Appelle initGroupStatusBridge(sock) d\'abord.');
        return false;
    }

    try {
        await _giftedStatusInstance.sendGroupStatus(groupJid, content);
        console.log(`[GroupStatusBridge] ✅ Statut groupe envoyé → ${groupJid}`);
        return true;
    } catch (err) {
        console.error(`[GroupStatusBridge] ❌ Erreur envoi statut groupe → ${groupJid}:`, err.message);
        return false;
    }
}

/**
 * Vérifie si le bridge est prêt.
 * @returns {boolean}
 */
function isGroupStatusBridgeReady() {
    return _giftedStatusInstance !== null;
}

module.exports = {
    initGroupStatusBridge,
    resetGroupStatusBridge,
    sendGroupStatus,
    isGroupStatusBridgeReady,
};
