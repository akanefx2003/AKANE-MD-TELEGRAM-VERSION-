// plugins/song.js
import yts from 'yt-search';
import axios from 'axios';

const API_HOST = 'youtube-mp36.p.rapidapi.com';
let keyIndex = 0;

function getApiKeys() {
    return (process.env.RAPIDAPI_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
}

async function getAudioBuffer(videoId) {
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
        return getAudioBuffer(videoId);
    }
    if (data?.status !== 'ok' || !data?.link) throw new Error('Échec du téléchargement (source indisponible)');

    const audioRes = await axios.get(data.link, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `https://${API_HOST}/` }
    });

    return { buffer: Buffer.from(audioRes.data), title: data.title };
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
        await ctx.telegram.editMessageText(ctx.chat.id, searching.message_id, undefined, `⏳ Téléchargement de "${video.title}"...`);

        try {
            const { buffer, title } = await getAudioBuffer(video.videoId);
            await ctx.replyWithAudio({ source: buffer, filename: `${title}.mp3` }, {
                title,
                caption: `🎵 ${title}\n⏱️ ${video.timestamp}`
            });
        } catch (err) {
            await ctx.reply(`❌ Erreur : ${err.message}`);
        }
    }
};
