// index.js — Bot Telegram AKANE (Telegraf) avec système de plugins dynamiques
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath, pathToFileURL } from 'url';

dotenv.config();

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR   = path.join(__dirname, 'plugins');
const DB_DIR        = path.join(__dirname, 'database');
const MEMBERS_FILE  = path.join(DB_DIR, 'members.json');

if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(DB_DIR))      fs.mkdirSync(DB_DIR, { recursive: true });

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('❌ BOT_TOKEN manquant — crée un fichier .env avec BOT_TOKEN=ton_token (voir .env.example)');
    process.exit(1);
}

const bot = new Telegraf(TOKEN);

// ─── Suivi des membres ─────────────────────────────────────────────────────────
// Telegram ne fournit AUCUN moyen pour un bot de lister tous les membres d'un
// groupe (contrairement à WhatsApp). On ne peut donc agir (ex: kickall) que sur
// les membres qu'on a "vus" passer depuis que le bot est actif dans le groupe.

function loadMembers() {
    try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf-8')); } catch { return {}; }
}
function saveMembers(data) { fs.writeFileSync(MEMBERS_FILE, JSON.stringify(data, null, 2)); }

function trackMember(chatId, userId, username) {
    const members = loadMembers();
    if (!members[chatId]) members[chatId] = {};
    members[chatId][userId] = { username: username || null, seenAt: new Date().toISOString() };
    saveMembers(members);
}

function untrackMember(chatId, userId) {
    const members = loadMembers();
    if (members[chatId]) { delete members[chatId][userId]; saveMembers(members); }
}

// Capte les entrées/sorties officielles du groupe
bot.on('chat_member', (ctx) => {
    const chatId = ctx.chat.id;
    const update = ctx.update.chat_member;
    const user   = update.new_chat_member.user;
    const status = update.new_chat_member.status;
    if (status === 'member' || status === 'administrator' || status === 'creator') {
        trackMember(chatId, user.id, user.username);
    } else if (status === 'left' || status === 'kicked') {
        untrackMember(chatId, user.id);
    }
});

// Filet de sécurité : mémorise aussi l'auteur de chaque message vu dans un groupe
bot.use((ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private' && ctx.from) {
        trackMember(ctx.chat.id, ctx.from.id, ctx.from.username);
    }
    return next();
});

// ─── Vérifie si l'auteur du message est admin du groupe (ou en privé) ─────────
async function isAdmin(ctx) {
    if (ctx.chat.type === 'private') return true;
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        return member.status === 'administrator' || member.status === 'creator';
    } catch {
        return false;
    }
}

// ─── Système de plugins ─────────────────────────────────────────────────────────
const plugins = new Map(); // name -> plugin

async function loadPlugin(filePath) {
    try {
        const url    = pathToFileURL(filePath).href + '?t=' + Date.now();
        const mod    = await import(url);
        const plugin = mod.default || mod;

        if (!plugin.name || !plugin.commands || !plugin.handler) {
            throw new Error('Plugin invalide : doit exporter { name, commands, handler }');
        }

        plugins.set(plugin.name, plugin);
        for (const cmd of plugin.commands) {
            bot.command(cmd, async (ctx) => {
                const args = ctx.message.text.trim().split(/\s+/).slice(1);
                try {
                    await plugin.handler(bot, ctx, args, { plugins, isAdmin, loadMembers, trackMember, untrackMember });
                } catch (err) {
                    console.error(`❌ Erreur plugin "${plugin.name}":`, err.message);
                    ctx.reply(`❌ Erreur : ${err.message}`).catch(() => {});
                }
            });
        }
        console.log(`✅ Plugin chargé : ${plugin.name} (${plugin.commands.join(', ')})`);
    } catch (err) {
        console.error(`❌ Erreur chargement plugin ${filePath}:`, err.message);
    }
}

async function loadAllPlugins() {
    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
    for (const file of files) await loadPlugin(path.join(PLUGINS_DIR, file));
    console.log(`📦 ${plugins.size} plugin(s) chargé(s)`);
}

// ─── Démarrage ───────────────────────────────────────────────────────────────────
(async () => {
    await loadAllPlugins();
    await bot.launch();
    console.log('✅ Bot Telegram connecté et prêt !');
})();

// Mini serveur HTTP — uniquement pour que Render (plan gratuit "Web Service")
// considère le service comme actif. Le bot lui-même tourne en polling (bot.launch()),
// il n'a besoin d'aucun port pour fonctionner.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Telegram actif ✅'); })
    .listen(PORT, () => console.log(`🌐 Ping HTTP actif sur le port ${PORT} (pour Render)`));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
