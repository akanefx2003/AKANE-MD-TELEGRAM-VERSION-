// plugins/song.js
import yts from 'yt-search';
import axios from 'axios';

const API_HOST = 'youtube-mp36.p.rapidapi.com';
let keyIndex = 0;

function getApiKeys() {
    return (process.env.RAPIDAPI_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
}

async function getAudioLink(videoId) {
    const keys = getApiKeys();
    if (keys.length === 0) throw new Error('Aucune clé RAPIDAPI_KEYS configurée dans .env');

    const apiKey = keys[keyIndex % keys.length];
    keyIndex++;

    const dlRes = await axios.get(`https://${API_HOST}/dl`, {
        params: { id: videoId },
        headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST },
        timeout: 30000
    });

    const data = dlRes.data;
    if (data?.status === 'processing') {
        await new Promise(r => setTimeout(r, 3000));
        return getAudioLink(videoId);
    }
    if (data?.status !== 'ok' || !data?.link) throw new Error('Échec du téléchargement (source indisponible)');

    return { url: data.link, title: data.title };
}

export default {
    name: 'song',
    description: 'Télécharger une musique depuis YouTube — /song [titre]',
    commands: ['song'],
    async handler(bot, ctx, args) {
        const query = args.join(' ').trim();
        if (!query) return ctx.reply('❓ Utilisation : /song [titre de la musique]');

        const searching = await ctx.reply('🔍 Recherche en cours...');

        const resultat = await yts(query);
        if (!resultat?.videos?.length) {
            return ctx.telegram.editMessageText(ctx.chat.id, searching.message_id, undefined, `❌ "${query}" introuvable sur YouTube`);
        }

        const video = resultat.videos[0];
        await ctx.telegram.editMessageText(ctx.chat.id, searching.message_id, undefined, `⏳ Préparation de "${video.title}"...`);

        try {
            const { url, title } = await getAudioLink(video.videoId);
            const caption = `🎵 ${title}\n⏱️ ${video.timestamp}`;

            // La connexion Render → Telegram peut parfois se couper sur l'hébergement
            // gratuit ("socket hang up") — on retente automatiquement avant d'abandonner.
            let lastErr = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await ctx.replyWithAudio({ url, filename: `${title}.mp3` }, { title, caption });
                    return;
                } catch (err) {
                    lastErr = err;
                    console.error(`[song] tentative audio ${attempt}/3 échouée :`, err.message);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
                }
            }

            // Dernier recours : envoyer en document plutôt qu'en audio
            // (Telegram traite parfois l'audio différemment — extraction de durée, etc. —
            // ce qui peut être ce qui cause le timeout ; le document est plus direct).
            try {
                await ctx.replyWithDocument({ url, filename: `${title}.mp3` }, { caption });
            } catch (err2) {
                await ctx.reply(`❌ Échec de l'envoi après plusieurs tentatives : ${lastErr?.message || err2.message}`);
            }
        } catch (err) {
            await ctx.reply(`❌ Erreur : ${err.message}`);
        }
    }
};
