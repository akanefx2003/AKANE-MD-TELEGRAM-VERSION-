// plugins/menu.js
export default {
    name: 'menu',
    description: 'Afficher la liste des commandes disponibles',
    commands: ['menu', 'help'],
    async handler(bot, ctx, args, { plugins }) {
        let text = '🤖 *AKANE — MENU*\n\n';
        for (const [, p] of plugins) {
            text += `• /${p.commands[0]} — ${p.description || 'Aucune description'}\n`;
        }
        await ctx.replyWithMarkdown(text);
    }
};
