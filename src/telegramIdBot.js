import 'dotenv/config';
import { Telegraf } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.command('id', async (ctx) => {
  await ctx.reply(
    [
      `chat_id: ${ctx.chat?.id}`,
      `message_thread_id: ${ctx.message?.message_thread_id || '(none)'}`,
      `from_id: ${ctx.from?.id}`,
    ].join('\n'),
  );
});

bot.start((ctx) => ctx.reply('Send /id in your Telegram forum group to get the group id.'));

await bot.launch();
console.log('Telegram ID helper is running. Send /id in the target Telegram group/topic.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
