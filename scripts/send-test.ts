/**
 * Send one real message to yourself.
 *
 *   npm run send:test -- --to=919876543210
 *   npm run send:test -- --to=919876543210 --intent=cart_saved
 *
 * The smoke test for the whole messaging path: compose a real template with
 * real variables and hand it to the real Cloud API. Everything except the
 * ladder.
 *
 * Deliberately requires an explicit `--to`. A default recipient in a script
 * that sends real WhatsApp messages is how someone eventually messages a
 * customer while testing.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { compose } from '../src/messaging/compose.js';
import { templateFor } from '../src/messaging/templates.js';
import { createWhatsAppClient } from '../src/adapters/whatsapp/client.js';
import { MESSAGE_INTENTS, type MessageIntent } from '../src/core/actions/types.js';
import { paise } from '../src/core/money.js';

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main(): Promise<void> {
  const to = arg('to');
  const intent = (arg('intent') ?? 'switch_method') as MessageIntent;

  if (!to) {
    console.error(
      '\n  --to is required. Use the number you added as a test recipient in\n' +
        '  App Dashboard > WhatsApp > API Setup, in E.164 without the plus:\n\n' +
        '    npm run send:test -- --to=919876543210\n',
    );
    process.exit(1);
  }

  if (!MESSAGE_INTENTS.includes(intent)) {
    console.error(`\n  Unknown intent '${intent}'. One of:\n    ${MESSAGE_INTENTS.join('\n    ')}\n`);
    process.exit(1);
  }

  const template = templateFor(intent);
  if (!template) {
    console.error(`\n  No template for '${intent}'.\n`);
    process.exit(1);
  }

  const composed = compose({
    intent,
    locale: 'en-IN',
    customerName: 'Rahul Sharma',
    merchantName: 'Kirana Cloud',
    amountPaise: paise(184_300),
    paymentLink: 'https://razorpay.com',
    debitAt: new Date(Date.now() + 3 * 86_400_000),
    planName: 'Pro plan',
  });

  if (!composed.ok) {
    console.error(`\n  Could not compose: ${composed.detail}\n`);
    process.exit(1);
  }

  console.log(`\n  Template: ${composed.message.templateName} (${composed.message.language})`);
  console.log('  ' + '─'.repeat(60));
  console.log(
    composed.message.preview
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  console.log('  ' + '─'.repeat(60));
  console.log(`  To: +${to.replace(/^\+/, '')}\n`);

  const client = createWhatsAppClient();
  const result = await client.sendTemplate({
    to,
    templateName: composed.message.templateName,
    language: composed.message.language,
    variables: composed.message.variables,
  });

  if (result.ok) {
    console.log(`  SENT — ${result.messageId}\n`);
    return;
  }

  console.error(`  FAILED — ${result.failure}: ${result.detail}`);

  // The two failures worth explaining, because the API message alone does not
  // say what to do about either.
  if (result.failure === 'variable_rejected') {
    console.error(
      '\n  Usually means the template is not APPROVED yet, or the variable count\n' +
        '  does not match. Check: npm run templates:status\n',
    );
  }
  if (result.failure === 'undeliverable') {
    console.error(
      '\n  On a Meta test number you can only message VERIFIED test recipients.\n' +
        '  Add this number under App Dashboard > WhatsApp > API Setup.\n',
    );
  }
  process.exit(1);
}

void main();
