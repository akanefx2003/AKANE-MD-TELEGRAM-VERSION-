// commands/wordgame.js
// @cat: game

import axios from 'axios';
import fs from 'fs';
import path from 'path';

const TURN_SECONDS = 7;
const START_LIVES  = 3;
const MIN_LEN      = 3;
const MAX_LEN      = 6;
const WIN_BONUS    = 5; // points bonus pour une victoire en multijoueur
// Lettres exclues car trop peu de mots courants en français (K, W, X, Y, Z)
const LETTERS = ['A','B','C','D','E','F','G','H','I','J','L','M','N','O','P','Q','R','S','T','U','V'];

const RANKING_FILE = path.join(process.cwd(), 'data', 'wordgame_ranking.json');

function loadRanking() {
    try {
        if (!fs.existsSync(RANKING_FILE)) return {};
        return JSON.parse(fs.readFileSync(RANKING_FILE, 'utf8'));
    } catch (e) {
        console.error('Erreur lecture ranking wordgame:', e.message);
        return {};
    }
}

function saveRanking(ranking) {
    try {
        fs.mkdirSync(path.dirname(RANKING_FILE), { recursive: true });
        fs.writeFileSync(RANKING_FILE, JSON.stringify(ranking, null, 2));
    } catch (e) {
        console.error('Erreur sauvegarde ranking wordgame:', e.message);
    }
}

function ensurePlayerEntry(ranking, id, name) {
    if (!ranking[id]) ranking[id] = { name, points: 0, wins: 0, gamesPlayed: 0 };
    ranking[id].name = name; // toujours garder le pseudo à jour
    return ranking[id];
}

function recordGameStart(players) {
    const ranking = loadRanking();
    for (const p of players) ensurePlayerEntry(ranking, p.id, p.name).gamesPlayed++;
    saveRanking(ranking);
}

function recordWordFound(id, name) {
    const ranking = loadRanking();
    ensurePlayerEntry(ranking, id, name).points++;
    saveRanking(ranking);
}

function recordWin(id, name) {
    const ranking = loadRanking();
    const entry = ensurePlayerEntry(ranking, id, name);
    entry.wins++;
    entry.points += WIN_BONUS;
    saveRanking(ranking);
}

function getTopPlayers(limit = 10) {
    return Object.values(loadRanking())
        .sort((a, b) => b.points - a.points)
        .slice(0, limit);
}

// sessions par jid (groupe ou DM) : { status, players:[{id,name,lives}], turnIndex, letter, length, usedWords:Set, timeout }
const sessions = new Map();

function normalize(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function randomLetter() {
    return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function randomLength() {
    return Math.floor(Math.random() * (MAX_LEN - MIN_LEN + 1)) + MIN_LEN;
}

// Vérifie l'existence du mot via l'API Wiktionnaire (gratuite, sans clé)
async function wordExists(word) {
    try {
        const res = await axios.get('https://fr.wiktionary.org/w/api.php', {
            params: {
                action: 'query',
                titles: word,
                format: 'json',
                redirects: 1
            },
            timeout: 5000
        });
        const pages = res.data?.query?.pages;
        if (!pages) return false;
        const page = Object.values(pages)[0];
        return !!page && !('missing' in page);
    } catch (e) {
        console.error('Erreur API Wiktionnaire:', e.message);
        return false;
    }
}

function currentPlayer(session) {
    return session.players[session.turnIndex];
}

function advanceTurn(session) {
    if (session.players.length === 0) return;
    session.turnIndex = (session.turnIndex + 1) % session.players.length;
}

function newRound(session) {
    session.letter = randomLetter();
    session.length = randomLength();
}

async function eliminateIfDead(client, jid, session, box) {
    if (session.mode === 'solo') return; // en solo, la partie s'arrête via endGameIfOver
    const player = currentPlayer(session);
    if (player.lives <= 0) {
        await client.sendMessage(jid, {
            text: box(`│ *💀 ${player.name} EST ÉLIMINÉ !*`)
        });
        session.players.splice(session.turnIndex, 1);
        if (session.turnIndex >= session.players.length) session.turnIndex = 0;
    }
}

async function endGameIfOver(client, jid, session, box) {
    if (session.mode === 'solo') {
        const player = session.players[0];
        if (player.lives <= 0) {
            await client.sendMessage(jid, {
                text: box(
                    `│ *🏁 PARTIE TERMINÉE*`, `│`,
                    `│ *Score final : ${session.score} mot(s) trouvé(s)*`
                )
            });
            clearTimeout(session.timeout);
            sessions.delete(jid);
            return true;
        }
        return false;
    }

    if (session.players.length <= 1) {
        const winner = session.players[0];
        if (winner) recordWin(winner.id, winner.name);
        await client.sendMessage(jid, {
            text: box(
                `│ *🏆 FIN DE LA PARTIE*`, `│`,
                winner ? `│ *Vainqueur : ${winner.name}*` : `│ *Aucun survivant*`
            )
        });
        clearTimeout(session.timeout);
        sessions.delete(jid);
        return true;
    }
    return false;
}

async function askTurn(client, jid, session, box) {
    newRound(session);
    const player = currentPlayer(session);

    const scoreLine = session.mode === 'solo' ? [`│ *Score : ${session.score}*`] : [];

    await client.sendMessage(jid, {
        text: box(
            `│ *🔤 ${session.mode === 'solo' ? 'À TOI DE JOUER' : `AU TOUR DE ${player.name}`}*`, `│`,
            `│ *Mot de ${session.length} lettres*`,
            `│ *Commençant par : ${session.letter}*`,
            `│ *Vies restantes : ${'❤️'.repeat(player.lives)}*`,
            ...scoreLine, `│`,
            `│ *⏱️ ${TURN_SECONDS} secondes !*`
        )
    });

    clearTimeout(session.timeout);
    session.timeout = setTimeout(async () => {
        try {
            await client.sendMessage(jid, {
                text: box(`│ *⏰ TEMPS ÉCOULÉ POUR ${player.name} !*`)
            });
            player.lives--;
            await eliminateIfDead(client, jid, session, box);
            const over = await endGameIfOver(client, jid, session, box);
            if (over) return;
            advanceTurn(session);
            await askTurn(client, jid, session, box);
        } catch (e) {
            console.error('Erreur timeout wordgame:', e.message);
        }
    }, TURN_SECONDS * 1000);
}

export default {
    name: 'wordgame',
    version: '1.0.0',
    description: 'Jeu de mots en temps limité (1v1 ou groupe)',
    commands: ['wordgame', 'mg'],
    category: 'game',
    async handler(client, message, args, { box, S }) {
        const jid    = message.key.remoteJid;
        const sender = message.key.participant || message.key.remoteJid;
        const name   = message.pushName || sender.split('@')[0];
        const sub    = (args[0] || '').toLowerCase();

        if (!sub || sub === 'help') {
            return client.sendMessage(jid, {
                text: box(
                    `│ *🔤 WORDGAME*`, `│`,
                    `│ *.wordgame create* — créer une partie`,
                    `│ *.wordgame join* — rejoindre (facultatif en solo)`,
                    `│ *.wordgame start* — démarrer (seul ou à plusieurs)`,
                    `│ *.wordgame stop* — arrêter la partie`,
                    `│ *.wordgame top* — classement des meilleurs joueurs`
                ),
                nativeFlow: S.chan
            });
        }

        if (sub === 'top' || sub === 'ranking' || sub === 'classement') {
            const top = getTopPlayers(10);
            if (top.length === 0) {
                return client.sendMessage(jid, { text: box(`│ *📊 Aucun classement pour l'instant*`) });
            }
            const medals = ['🥇', '🥈', '🥉'];
            const lines = top.map((p, i) =>
                `│ ${medals[i] || `${i + 1}.`} *${p.name}* — ${p.points} pts (${p.wins} 🏆, ${p.gamesPlayed} parties)`
            );
            return client.sendMessage(jid, {
                text: box(`│ *📊 CLASSEMENT WORDGAME*`, `│`, ...lines)
            });
        }

        if (sub === 'create') {
            if (sessions.has(jid)) {
                return client.sendMessage(jid, { text: box(`│ *❌ Une partie existe déjà ici*`) });
            }
            sessions.set(jid, {
                status: 'lobby',
                mode: null,
                score: 0,
                players: [{ id: sender, name, lives: START_LIVES }],
                turnIndex: 0,
                letter: null,
                length: null,
                usedWords: new Set(),
                timeout: null
            });
            return client.sendMessage(jid, {
                text: box(
                    `│ *🎮 PARTIE CRÉÉE PAR ${name}*`, `│`,
                    `│ *.wordgame join* pour rejoindre à plusieurs`,
                    `│ *.wordgame start* pour lancer (seul ou à plusieurs)`
                ),
                nativeFlow: S.chan
            });
        }

        const session = sessions.get(jid);
        if (!session) {
            return client.sendMessage(jid, { text: box(`│ *❌ Aucune partie en cours. Fais .wordgame create*`) });
        }

        if (sub === 'join') {
            if (session.status !== 'lobby') {
                return client.sendMessage(jid, { text: box(`│ *❌ La partie a déjà commencé*`) });
            }
            if (session.players.some(p => p.id === sender)) {
                return client.sendMessage(jid, { text: box(`│ *❌ Tu es déjà inscrit*`) });
            }
            session.players.push({ id: sender, name, lives: START_LIVES });
            return client.sendMessage(jid, {
                text: box(`│ *✅ ${name} a rejoint (${session.players.length} joueurs)*`)
            });
        }

        if (sub === 'start') {
            if (session.status !== 'lobby') {
                return client.sendMessage(jid, { text: box(`│ *❌ La partie a déjà commencé*`) });
            }
            session.mode   = session.players.length === 1 ? 'solo' : 'multi';
            session.status = 'playing';
            recordGameStart(session.players);
            const intro = session.mode === 'solo'
                ? `│ *Mode solo — trouve un maximum de mots avant de perdre tes vies*`
                : `│ *${session.players.length} joueurs, que le meilleur gagne*`;
            await client.sendMessage(jid, {
                text: box(`│ *🚀 LA PARTIE COMMENCE !*`, `│`, intro)
            });
            await askTurn(client, jid, session, box);
            return;
        }

        if (sub === 'stop') {
            clearTimeout(session.timeout);
            sessions.delete(jid);
            return client.sendMessage(jid, { text: box(`│ *🛑 Partie arrêtée*`) });
        }

        return client.sendMessage(jid, { text: box(`│ *❌ Commande inconnue, essaie .wordgame help*`) });
    },

    // Hook appelé sur chaque message : capte les réponses pendant une partie en cours
    async onMessage(client, message, { box }) {
        const jid    = message.key.remoteJid;
        const sender = message.key.participant || message.key.remoteJid;
        const session = sessions.get(jid);
        if (!session || session.status !== 'playing') return;

        const body = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
        if (!body || body.startsWith('.')) return; // ignore les commandes

        const player = currentPlayer(session);
        if (!player || sender !== player.id) return; // pas son tour

        const word = normalize(body);
        const letterOk = word.length > 0 && word[0] === normalize(session.letter);
        const lengthOk = word.length === session.length;
        const notUsed  = !session.usedWords.has(word);
        const isAlpha  = /^[a-zàâäéèêëïîôöùûüÿçñæœ]+$/i.test(word);

        let valid = false;
        if (letterOk && lengthOk && notUsed && isAlpha) {
            valid = await wordExists(word);
        }

        clearTimeout(session.timeout);

        if (valid) {
            session.usedWords.add(word);
            if (session.mode === 'solo') session.score++;
            recordWordFound(player.id, player.name);
            await client.sendMessage(jid, {
                text: box(`│ *✅ ${player.name} : "${body}" est valide !*`)
            });
        } else {
            player.lives--;
            let reason = 'Mot invalide';
            if (!letterOk) reason = `Doit commencer par ${session.letter}`;
            else if (!lengthOk) reason = `Doit faire ${session.length} lettres`;
            else if (!notUsed) reason = 'Mot déjà utilisé';
            else if (!isAlpha) reason = 'Caractères invalides';

            await client.sendMessage(jid, {
                text: box(`│ *❌ ${player.name} : ${reason} (-1 vie)*`)
            });
        }

        await eliminateIfDead(client, jid, session, box);
        const over = await endGameIfOver(client, jid, session, box);
        if (over) return;

        advanceTurn(session);
        await askTurn(client, jid, session, box);
    }
};
