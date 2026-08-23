// plugins/ping.js
export default {
    name: 'ping',
    description: 'Vérifier que le bot répond',
    commands: ['ping'],
    async handler(bot, ctx) {
        const start = Date.now();
        const sent  = await ctx.reply('🏓 Pong...');
        const ms    = Date.now() - start;
        await ctx.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined, `🏓 Pong ! (${ms}ms)`);
    }
};
