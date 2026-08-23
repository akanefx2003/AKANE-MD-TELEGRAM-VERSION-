// plugins/kick.js
export default {
    name: 'kick',
    description: 'Retirer un membre — réponds à son message avec /kick',
    commands: ['kick'],
    async handler(bot, ctx, args, { isAdmin, untrackMember }) {
        if (ctx.chat.type === 'private') return ctx.reply('❌ Commande réservée aux groupes.');
        if (!(await isAdmin(ctx))) return ctx.reply('❌ Réservé aux admins du groupe.');

        const target = ctx.message.reply_to_message?.from;
        if (!target) return ctx.reply('❓ Réponds au message de la personne à retirer avec /kick.');
        if (target.is_bot && ctx.botInfo && target.id === ctx.botInfo.id) {
            return ctx.reply('❌ Je ne peux pas me retirer moi-même.');
        }

        try {
            await ctx.telegram.banChatMember(ctx.chat.id, target.id);
            await ctx.telegram.unbanChatMember(ctx.chat.id, target.id); // ban + unban = "kick" (autorise à revenir)
            untrackMember(ctx.chat.id, target.id);
            await ctx.reply(`✅ ${target.first_name} a été retiré du groupe.`);
        } catch (err) {
            await ctx.reply(`❌ Impossible de le retirer : ${err.message}`);
        }
    }
};
