// 📤 LIB: MEDIA UPLOADER
// Upload images/vidéos vers une URL publique (Inspiré de SEN BOT)

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

// Service 1: ImgBB (Images uniquement, très fiable via Base64)
async function imgbb(buffer) {
    try {
        const formData = new FormData();
        formData.append('image', buffer.toString('base64'));
        
        // Utilisation de la même clé API publique que SEN
        const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
            params: { key: '254b685aea07ed364f7091dee628d26b' },
            headers: { ...formData.getHeaders() }
        });

        if (response.data?.data?.url) {
            return response.data.data.url;
        }
        throw new Error('Réponse ImgBB invalide');
    } catch (e) {
        console.error('ImgBB Error:', e.message);
        throw e;
    }
}

// Service 2: Catbox.moe (Fichiers, Vidéos)
async function catbox(buffer, ext = 'mp4') {
    try {
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        formData.append('userhash', ''); // Anonyme
        // Correction cruciale : passer un objet option avec filename pour FormData
        formData.append('fileToUpload', buffer, { filename: `media.${ext}` });

        const response = await axios.post('https://catbox.moe/user/api.php', formData, {
            headers: { ...formData.getHeaders() }
        });

        if (response.data && response.data.startsWith('http')) {
            return response.data.trim();
        }
        throw new Error('Réponse Catbox invalide');
    } catch (e) {
        console.error('Catbox Error:', e.message);
        throw e;
    }
}

// Fonction principale (Auto-switch)
async function uploadMedia(message) {
    try {
        // Extraction du buffer
        const type = Object.keys(message)[0];
        const mediaObj = message[type];
        const { downloadContentFromMessage } = await import('baileys');
        const stream = await downloadContentFromMessage(mediaObj, type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        // Si c'est une image -> ImgBB direct (très stable)
        if (type === 'imageMessage') {
            try {
                return await imgbb(buffer);
            } catch (e) {
                console.log('Fallback to Catbox for image...');
            }
        }

        // Vidéo ou fallback Image -> Catbox
        const mime = mediaObj?.mimetype || '';
        let ext = mime.includes('video') ? 'mp4' : 'png';
        
        return await catbox(buffer, ext);

    } catch (error) {
        console.error('UploadMedia Error:', error.message);
        return null;
    }
}

module.exports = { uploadMedia };