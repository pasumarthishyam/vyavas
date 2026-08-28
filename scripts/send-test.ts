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

/**
 * Read a flag, whichever way it survived the shell.
 *
 * npm on Windows does NOT forward `--to=x` to the script. It parses the flag as
 * an npm config option and exposes it as `npm_config_to`, leaving
 * `process.argv` empty — so the documented command silently does nothing.
 * Reading all three forms makes it work regardless of shell and npm version.
 */
function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (flag) return flag;
  const fromNpm = process.env[`npm_config_${name}`];
  return fromNpm && fromNpm.length > 0 ? fromNpm : undefined;
}

/** First bare argument — anything not starting with a dash. */
function positional(): string | undefined {
  return process.argv.slice(2).find((a) => !a.startsWith('-'));
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.env[`npm_config_${name}`] === 'true';
}

/**
 * Keep only digits.
 *
 * Strips `+91`, spaces, and the angle brackets people copy from placeholder
 * docs — PowerShell treats `<` as a redirect, so `--to=<91…>` fails in a way
 * that looks like the script is broken.
 */
function normalizeRecipient(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

async function main(): Promise<void> {
  const rawTo = arg('to') ?? positional() ?? process.env.WHATSAPP_TEST_RECIPIENT;
  const to = rawTo ? normalizeRecipient(rawTo) : undefined;
  const intent = (arg('intent') ?? 'switch_method') as MessageIntent;

  if (!to || to.length < 10) {
    console.error(
      '\n  No recipient. Any of these works — the number must already be added as\n' +
        '  a test recipient under App Dashboard > WhatsApp > API Setup:\n\n' +
        '    npm run send:test -- 919876543210        <- simplest, works everywhere\n' +
        '    npm run send:test -- --to=919876543210\n' +
        '    WHATSAPP_TEST_RECIPIENT="919876543210"   <- in .env.local, then no flag\n\n' +
        '  Country code, no plus, no angle brackets.\n',
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

  const freeForm = hasFlag('free-form');
  const client = createWhatsAppClient();

  // Free-form sends the same composed copy as plain text. It works ONLY inside
  // the 24-hour customer service window — the period after the recipient
  // messages the business number. That makes it a way to read the real wording
  // on a real phone while templates are in review, and nothing more: a customer
  // who abandoned a payment never wrote to us, so no window exists and Meta
  // returns 131047. Which is exactly why production uses templates.
  const result = freeForm
    ? await client.sendText({ to, text: composed.message.preview })
    : await client.sendTemplate({
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
      freeForm
        ? '\n  No open 24-hour window, or the number is not a verified test recipient.\n' +
            '    1. Add the number under App Dashboard > WhatsApp > API Setup\n' +
            '    2. From that phone, WhatsApp the test number (+1 555-665-2053)\n' +
            '    3. Re-run this within 24 hours\n'
        : '\n  A Meta test number can only message VERIFIED test recipients.\n' +
            '  Add this number under App Dashboard > WhatsApp > API Setup.\n',
    );
  }
  process.exit(1);
}

void main();
