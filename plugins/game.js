// AKANE MD v2 — Bot WhatsApp avec système de plugins dynamiques
// Usage: node index.js

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from '@crysnovax/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR   = path.join(__dirname, 'plugins');
const PLUGINS_FILE  = path.join(__dirname, 'database', 'plugins.json');
const CONFIG_FILE   = path.join(__dirname, 'database', 'config.json');
const CHANNEL_LINK  = 'https://whatsapp.com/channel/0029Vb8JcmVEVccLHB0tUY2D';

if (!fs.existsSync(PLUGINS_DIR))  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'database'))) fs.mkdirSync(path.join(__dirname, 'database'), { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
    const defaults = { prefix: '.', publicMode: false, sudoList: [], reaction: '🌹' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ─── Style ────────────────────────────────────────────────────────────────────

const S = {
    top:   '╭┄─̣✦┄─̣✦┄─̣✦┄─̣✦',
    mid:   '│┄─̣┄─̣┄─̣┄─̣┄─̣',
    bot:   '╰┄─̣✦┄─̣✦┄─̣✦┄─̣✦',
    title: '│ ⊹ *ɑׁׁׅׅƙׁׁׅׅɑׁׁׅׅ݊ꪀׁׅꫀׁׁׅܻׅ݊ ꩇׁׅ֪݊ ׁׅժׁׁׅׅ v²* ⊹',
    foot:  '\n> *© AKANE MD v2 🌹*',
    chan:  [{ text: 'VOIR LA CHAÎNE 🍁', url: CHANNEL_LINK }],
};
function box(...lines) {
    return [S.top, S.title, S.mid, ...lines, S.bot + S.foot].join('\n');
}

// ─── Gestionnaire de plugins ──────────────────────────────────────────────────

class PluginManager {
    constructor() {
        this.plugins = new Map(); // name → { meta, handler }
        this.registry = this._loadRegistry();
    }

    _loadRegistry() {
        try {
            if (fs.existsSync(PLUGINS_FILE)) return JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8'));
        } catch {}
        return [];
    }

    _saveRegistry() {
        fs.writeFileSync(PLUGINS_FILE, JSON.stringify(this.registry, null, 2));
    }

    // Charger un plugin depuis un fichier .js local
    async loadFromFile(filePath) {
        try {
            const url     = pathToFileURL(filePath).href + '?t=' + Date.now();
            const mod     = await import(url);
            const plugin  = mod.default || mod;

            if (!plugin.name || !plugin.commands || !plugin.handler) {
                throw new Error('Plugin invalide : doit exporter { name, commands, description, handler }');
            }

            this.plugins.set(plugin.name, { meta: plugin, handler: plugin.handler });
            console.log(`✅ Plugin chargé : ${plugin.name} (${plugin.commands.join(', ')})`);
            return plugin;
        } catch (err) {
            console.error(`❌ Erreur chargement plugin ${filePath}:`, err.message);
            throw err;
        }
    }

    // Télécharger + installer un plugin depuis une URL
    async installFromUrl(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} — URL inaccessible`);

        const code     = await res.text();
        const nameMatch = code.match(/name:\s*['"`](.+?)['"`]/);
        const plugName  = nameMatch ? nameMatch[1] : `plugin_${Date.now()}`;
        const fileName  = `${plugName.replace(/\s+/g, '_')}.js`;
        const filePath  = path.join(PLUGINS_DIR, fileName);

        fs.writeFileSync(filePath, code);

        const plugin = await this.loadFromFile(filePath);

        // Enregistrer dans le registre local
        const existing = this.registry.findIndex(p => p.name === plugin.name);
        const entry = { name: plugin.name, description: plugin.description || '', url, file: fileName, installedAt: new Date().toISOString() };
        if (existing !== -1) this.registry[existing] = entry;
        else this.registry.push(entry);
        this._saveRegistry();

        return plugin;
    }

    // Désinstaller un plugin
    uninstall(name) {
        if (!this.plugins.has(name)) throw new Error(`Plugin "${name}" introuvable`);
        const entry = this.registry.find(p => p.name === name);
        if (entry?.file) {
            const filePath = path.join(PLUGINS_DIR, entry.file);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        this.plugins.delete(name);
        this.registry = this.registry.filter(p => p.name !== name);
        this._saveRegistry();
    }

    // Charger tous les plugins du dossier au démarrage
    async loadAll() {
        const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try { await this.loadFromFile(path.join(PLUGINS_DIR, file)); } catch {}
        }
        console.log(`📦 ${this.plugins.size} plugin(s) chargé(s)`);
    }

    // Trouver le plugin qui gère une commande
    resolve(command) {
        for (const [, { meta, handler }] of this.plugins) {
            if (meta.commands.includes(command)) return { meta, handler };
        }
        return null;
    }

    list() { return [...this.plugins.values()].map(p => p.meta); }
}

const pluginManager = new PluginManager();

// ─── Commandes intégrées (core) ───────────────────────────────────────────────

async function handleCoreCommand(client, message, command, args, config) {
    const sender = message.key.remoteJid;

    switch (command) {

        // ── plugin add [url] ──
        case 'plugin': {
            const sub = args[0]?.toLowerCase();

            if (sub === 'add') {
                const url = args[1];
                if (!url) return client.sendMessage(sender, {
                    text: box(`│ *📦 INSTALLER UN PLUGIN*`, `│`, `│ *Usage : ${config.prefix}plugin add [URL]*`, `│`, `│ *Exemple :*`, `│ *${config.prefix}plugin add https://akane-store-nine.vercel.app/p/sticker.js*`),
                    nativeFlow: S.chan
                }, { quoted: message });

                await client.sendMessage(sender, { text: `⏳ *Iׁׅnׁׅsׁׅtׁׅaׁׅlׁׅlׁׅaׁׅtׁׅiׁׅoׁׅnׁׅ eׁׅnׁׅ cׁׅoׁׅuׁׅrׁׅsׁׅ...*` }, { quoted: message });

                try {
                    const plugin = await pluginManager.installFromUrl(url);
                    return client.sendMessage(sender, {
                        text: box(
                            `│ *✅ PLUGIN INSTALLÉ !*`, `│`,
                            `│ *📦 NOM : ${plugin.name}*`,
                            `│ *📝 DESC : ${plugin.description || 'Aucune'}*`,
                            `│ *⚡ COMMANDES : ${plugin.commands.map(c => config.prefix + c).join(', ')}*`,
                        ),
                        nativeFlow: S.chan
                    });
                } catch (err) {
                    return client.sendMessage(sender, {
                        text: box(`│ *❌ INSTALLATION ÉCHOUÉE*`, `│`, `│ *${err.message}*`),
                        nativeFlow: S.chan
                    });
                }
            }

            if (sub === 'remove' || sub === 'del') {
                const name = args.slice(1).join(' ');
                if (!name) return client.sendMessage(sender, {
                    text: box(`│ *Usage : ${config.prefix}plugin remove [nom]*`), nativeFlow: S.chan
                }, { quoted: message });
                try {
                    pluginManager.uninstall(name);
                    return client.sendMessage(sender, {
                        text: box(`│ *✅ PLUGIN SUPPRIMÉ : ${name}*`), nativeFlow: S.chan
                    });
                } catch (err) {
                    return client.sendMessage(sender, {
                        text: box(`│ *❌ ${err.message}*`), nativeFlow: S.chan
                    });
                }
            }

            if (sub === 'list' || sub === 'ls' || !sub) {
                const list = pluginManager.list();
                if (list.length === 0) return client.sendMessage(sender, {
                    text: box(`│ *📦 AUCUN PLUGIN INSTALLÉ*`, `│`, `│ *Installe-en un avec :*`, `│ *${config.prefix}plugin add [URL]*`),
                    nativeFlow: S.chan
                }, { quoted: message });

                let lines = [S.top, S.title, S.mid, `│ *📦 PLUGINS INSTALLÉS (${list.length})*`, `│`];
                list.forEach((p, i) => {
                    lines.push(`│ *${i + 1}. ${p.name}*`);
                    if (p.description) lines.push(`│    ${p.description}`);
                    lines.push(`│    ⚡ ${p.commands.map(c => config.prefix + c).join(' • ')}`);
                    lines.push(`│`);
                });
                lines.push(S.bot + S.foot);
                return client.sendMessage(sender, { text: lines.join('\n'), nativeFlow: S.chan });
            }

            if (sub === 'reload') {
                const name = args[1];
                if (!name) {
                    pluginManager.plugins.clear();
                    await pluginManager.loadAll();
                    return client.sendMessage(sender, {
                        text: box(`│ *✅ TOUS LES PLUGINS RECHARGÉS*`, `│`, `│ *📦 ${pluginManager.plugins.size} plugin(s) actif(s)*`),
                        nativeFlow: S.chan
                    });
                }
                const entry = pluginManager.registry.find(p => p.name === name);
                if (!entry) return client.sendMessage(sender, { text: box(`│ *❌ Plugin "${name}" introuvable*`), nativeFlow: S.chan });
                pluginManager.plugins.delete(name);
                await pluginManager.loadFromFile(path.join(PLUGINS_DIR, entry.file));
                return client.sendMessage(sender, { text: box(`│ *✅ PLUGIN RECHARGÉ : ${name}*`), nativeFlow: S.chan });
            }

            break;
        }

        // ── menu ──
        case 'menu':
        case 'help': {
            const list  = pluginManager.list();
            const pfx   = config.prefix;
            const uptime = process.uptime();
            const days  = Math.floor(uptime / 86400);
            const hours = Math.floor((uptime % 86400) / 3600);
            const mins  = Math.floor((uptime % 3600) / 60);
            const secs  = Math.floor(uptime % 60);
            const uptimeStr = `${days}𝗝:${hours}𝗛:${mins}𝗠:${secs}𝗦`;
            const now   = new Date();
            const dateStr = `${now.getDate().toString().padStart(2,'0')} ${['JAN','FÉV','MAR','AVR','MAI','JUIN','JUIL','AOÛ','SEP','OCT','NOV','DÉC'][now.getMonth()]} ${now.getFullYear()}`;

            // Grouper plugins par catégorie
            const bycat = {};
            for (const p of list) {
                if (p.enabled === false) continue;
                const cat = p.category || 'general';
                if (!bycat[cat]) bycat[cat] = [];
                bycat[cat].push(p);
            }

            const catLabel = { tools:'𝘁𝗼𝗼𝗹𝘀-𝗶𝗮🔧', fun:'𝗳𝘂𝗻🎉', media:'𝗺𝗲𝗱𝗶𝗮📁', general:'𝗴𝗲𝗻𝗲𝗿𝗮𝗹📦', admin:'𝗮𝗱𝗺𝗶𝗻⚙️', games:'𝗴𝗮𝗺𝗲𝘀🎮' };

            let caption = '';

            // ── BOT INFO ──
            caption += `╭┄─̣✦┄─̣✦┄─̣✦┄─̣✦┄─̣✦\n`;
            caption += `*│𝐀𝐊𝐀𝐍𝐄-𝐌𝐃 𝐕𝟐*\n\n`;
            caption += `*│𝐁𝐎𝐓-𝐈𝐍𝐅𝐎*\n\n`;
            caption += `*│𝐖𝐄𝐁 :* https://akane-store-nine.vercel.app/\n\n`;
            caption += `*│𝐕𝐄𝐑𝐒𝐈𝐎𝐍 :* *\`𝟐.𝟎.𝟎\`*\n\n`;
            caption += `*│𝐃𝐄𝐕 :* _\`𝗮𝗸𝗮𝗻𝗲 𝗫 𝘀𝗼𝗿𝗮\`_\n\n`;
            caption += `*│𝐔𝐏𝐓𝐈𝐌𝐄 :* \`${uptimeStr}\`\n\n`;
            caption += `*│𝐏𝐑𝐄𝐅𝐈𝐗𝐄 :* \`(${pfx})\`\n\n`;
            caption += `*│𝐃𝐀𝐓𝐄 :* \`${dateStr}\`\n`;
            caption += `╰┄─̣✦┄─̣✦┄─̣✦┄─̣✦┄─̣✦\n\n`;

            // ── BOT-MENU (core) ──
            caption += `╭┄─̣✦(𝗯𝗼𝘁-𝗺𝗲𝗻𝘂🤖)\n\n`;
            caption += `> *_𝗽𝗹𝘂𝗴𝗶𝗻_*\n`;
            caption += `> *_𝗽𝗶𝗻𝗴_*\n`;
            caption += `> *_𝘀𝗲𝘁𝗽𝗿𝗲𝗳𝗶𝘅_*\n`;
            caption += `> *_𝗽𝘂𝗯𝗹𝗶𝗰_*\n`;
            caption += `> *_𝗽𝗿𝗶𝘃𝗮𝘁𝗲_*\n\n`;
            caption += `╰┄─̣✦┄─̣✦┄─̣✦┄\n\n`;

            // ── Catégories plugins ──
            for (const [cat, plugins] of Object.entries(bycat)) {
                const label = catLabel[cat] || `${cat}📦`;
                caption += `╭┄─̣✦(${label})\n\n`;
                for (const p of plugins) {
                    for (const cmd of p.commands) {
                        caption += `> *_${cmd}_*\n`;
                    }
                }
                caption += `\n╰┄─̣✦┄─̣✦┄─̣✦┄\n\n`;
            }

            caption += `> *© AKANE MD v2 🌹*`;

            return client.sendMessage(sender, {
                image: { url: 'https://cdn.crysnovax.link/files/1781566333440-712f9269-603b-4913-a265-73c35aa122ed.jpg' },
                caption,
                nativeFlow: S.chan
            });
        }

        case 'ping': {
            const start = Date.now();
            await client.sendMessage(sender, { react: { text: '🏓', key: message.key } });
            const ms = Date.now() - start;
            return client.sendMessage(sender, {
                text: box(`│ *🏓 PONG !*`, `│`, `│ *⚡ LATENCE : ${ms}ms*`),
                nativeFlow: S.chan
            }, { quoted: message });
        }

        case 'setprefix': {
            const newPrefix = args[0];
            if (!newPrefix || newPrefix.length > 3) return client.sendMessage(sender, {
                text: box(`│ *Usage : ${config.prefix}setprefix [caractère]*`), nativeFlow: S.chan
            }, { quoted: message });
            config.prefix = newPrefix;
            saveConfig(config);
            return client.sendMessage(sender, {
                text: box(`│ *✅ PRÉFIXE CHANGÉ : ${newPrefix}*`), nativeFlow: S.chan
            });
        }

        case 'public': {
            config.publicMode = true;
            saveConfig(config);
            return client.sendMessage(sender, { text: box(`│ *✅ MODE PUBLIC ACTIVÉ*`), nativeFlow: S.chan });
        }

        case 'private':
        case 'privé': {
            config.publicMode = false;
            saveConfig(config);
            return client.sendMessage(sender, { text: box(`│ *✅ MODE PRIVÉ ACTIVÉ*`), nativeFlow: S.chan });
        }
    }
}

// ─── Handler principal ────────────────────────────────────────────────────────

const CORE_COMMANDS = ['menu', 'help', 'ping', 'plugin', 'setprefix', 'public', 'private', 'privé'];

async function handleMessage(client, event) {
    const config  = loadConfig();
    const { prefix, publicMode, sudoList } = config;
    const number  = client.user.id.split(':')[0];
    const msgs    = event.messages;

    for (const message of msgs) {
        if (!message.message) continue;
        const body      = (message.message?.extendedTextMessage?.text || message.message?.conversation || '').trim();
        const sender    = message.key.remoteJid;
        const fromMe    = message.key.fromMe;
        const senderJid = message.key.participant || sender;
        const isAllowed = publicMode || fromMe || sudoList.includes(senderJid);

        // ── Hooks onMessage des plugins (ex: jeux en cours attendant une réponse) ──
        for (const [, { meta }] of pluginManager.plugins) {
            if (typeof meta.onMessage === 'function') {
                try {
                    await meta.onMessage(client, message, { config, box, S, CHANNEL_LINK });
                } catch (e) {
                    console.error(`❌ Erreur onMessage plugin "${meta.name}":`, e.message);
                }
            }
        }

        // ── Commandes pair (toujours public, tout préfixe) ──
        const pairMatch = body.match(/^[^\w\s]?pair\s+(\d{7,})/i);
        if (pairMatch) {
            // Espace pour la commande pair si besoin
            console.log(`🔑 Pair demandé pour +${pairMatch[1]}`);
            continue;
        }

        if (!body.startsWith(prefix)) continue;

        const commandAndArgs = body.slice(prefix.length).trim();
        const parts          = commandAndArgs.split(/\s+/);
        const command        = parts[0].toLowerCase();
        const args           = parts.slice(1);

        // Commandes core
        if (CORE_COMMANDS.includes(command)) {
            const isMenuCmd = command === 'menu' || command === 'help';
            // menu/help sont en lecture seule : accessibles à tout le monde, sans condition
            const canRun = isMenuCmd ? true : (fromMe || sudoList.includes(senderJid));
            if (!canRun) continue;
            try { await handleCoreCommand(client, message, command, args, config); } catch (e) { console.error(e); }
            continue;
        }

        // Commandes plugins : respecte publicMode
        if (!isAllowed) continue;

        const resolved = pluginManager.resolve(command);
        if (!resolved) continue;

        try {
            await client.sendMessage(sender, { react: { text: config.reaction || '🌹', key: message.key } });
            await resolved.handler(client, message, args, { config, box, S, CHANNEL_LINK });
        } catch (err) {
            console.error(`❌ Erreur plugin "${command}":`, err.message);
            await client.sendMessage(sender, {
                text: box(`│ *❌ ERREUR PLUGIN*`, `│`, `│ *${err.message}*`),
                nativeFlow: S.chan
            }).catch(() => {});
        }
    }
}

// ─── Connexion WhatsApp (pairing code) ───────────────────────────────────────

import readline from 'readline';

function askNumber() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('\n📱 Entre ton numéro WhatsApp (ex: 242053889794) : ', (ans) => {
            rl.close();
            resolve(ans.trim().replace(/[^0-9]/g, ''));
        });
    });
}

async function startBot() {
    await pluginManager.loadAll();

    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('./sessions/main');

    const sock = makeWASocket({
        version,
        auth:                           state,
        printQRInTerminal:              false,
        logger:                         pino({ level: 'silent' }),
        browser:                        Browsers.ubuntu('Chrome'),
        keepAliveIntervalMs:            10000,
        connectTimeoutMs:               60000,
        syncFullHistory:                false,
        markOnlineOnConnect:            true,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    let codeSent = false;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

        // ── Demander le code de pairing dès la connexion ──
        if (connection === 'connecting' && !codeSent && !sock.authState.creds.registered) {
            codeSent = true;
            await new Promise(r => setTimeout(r, 2000));
            try {
                let number = loadConfig().owner;
                if (!number) number = await askNumber();
                number = number.replace(/[^0-9]/g, '');

                const code = await sock.requestPairingCode(number);
                const fmt  = code.match(/.{1,4}/g)?.join('-') || code;

                console.log(`\n╭┄─̣✦┄─̣✦┄─̣✦┄─̣✦`);
                console.log(`│ ⊹ AKANE MD v2 ⊹`);
                console.log(`│┄─̣┄─̣┄─̣┄─̣┄─̣`);
                console.log(`│ 🔑 NUMÉRO : +${number}`);
                console.log(`│ 🔐 CODE   : ${fmt}`);
                console.log(`│ ⚠️  EXPIRE DANS : 60s`);
                console.log(`╰┄─̣✦┄─̣✦┄─̣✦┄─̣✦`);
                console.log(`\n👉 Va dans WhatsApp → Appareils connectés → Connecter → Entre l