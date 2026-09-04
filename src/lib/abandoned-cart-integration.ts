/**
 * The two things a merchant needs to wire an abandoned cart into this agent:
 * a snippet they can paste directly, and a prompt they can hand to an AI
 * coding tool (Cursor, Antigravity, Copilot) to do the wiring for them.
 *
 * Both are generated here, with the merchant's real endpoint and key already
 * filled in, rather than left as placeholders — a snippet a new merchant has
 * to hand-edit before it works is exactly the kind of ambiguity that produces
 * a support ticket instead of a working integration.
 *
 * Pure string templates, deliberately. Nothing here talks to the database or
 * the network, so the exact text a merchant is about to paste can be unit-
 * tested without a running server.
 */

export interface AbandonedCartIntegrationInput {
  readonly endpoint: string;
  readonly apiKey: string | null;
}

export function buildCodeSnippet(input: AbandonedCartIntegrationInput): string {
  const key = input.apiKey ?? '<GENERATE A KEY ABOVE FIRST>';
  return `// Call this once, whenever a customer leaves your checkout/cart without
// EVER ATTEMPTING to pay — e.g. on exit-intent, on a checkout page unloading,
// or from a scheduled job that finds carts idle for N minutes with no
// completed order.
//
// Do NOT call it when a payment was attempted and failed. That is a different
// thing with its own agent: the failure webhook already reports it, and the
// customer gets a message about the actual reason. Sending this as well means
// two messages for one event, the second offering a discount on a checkout
// they were genuinely trying to pay for.
//
// Sending it anyway is safe — it is recorded and declined, not emailed — but
// checking here is better, because only your app can see the difference.
// Fire-and-forget: don't block your UI on the response.
fetch('${input.endpoint}', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ${key}',
  },
  body: JSON.stringify({
    cartId: cart.id,               // required — your own cart/order id, unique per cart
    customerEmail: customer.email, // required — the only channel this agent uses
    customerName: customer.name,   // optional
    customerPhone: customer.phone, // optional, but SEND IT — see below
    amountPaise: cart.totalPaise,  // required — cart total in PAISE (₹1 = 100), a whole number
  }),
});`;
}

export function buildAiPrompt(input: AbandonedCartIntegrationInput): string {
  const key = input.apiKey ?? '<GENERATE A KEY ABOVE FIRST>';
  return `I want to detect when a customer abandons their shopping cart in this app — they added items and/or started checkout, then left without completing payment — and report it by making a single HTTP webhook call. This is NOT an email you send yourself and NOT a database write to any table of mine — it is one outbound HTTP POST request to an external service that will handle the discount email on its own.

What counts as "abandoned": the customer has items in their cart and/or started checkout, then either (a) leaves the site or closes the tab, or (b) the cart sits untouched for more than 15 minutes with no completed order. Trigger this exactly ONCE per cart — never call it again for a cart that was already reported, and never call it for a cart that already completed payment.

IMPORTANT — do NOT call this when the customer ATTEMPTED a payment and it failed or was declined. That is a different situation handled by a different system: the payment provider reports the failure directly and the customer already receives a message about the specific reason it failed. Reporting it here as well produces a second message for the same event, offering a discount on a checkout the customer was actively trying to pay for. If your code can tell that a payment attempt was made — a payment/order was created, a checkout handler fired, the provider returned a failure — then it is NOT an abandoned cart and this webhook must not be called. Only report checkouts the customer left WITHOUT ever asking to be charged.

When abandonment is detected, make exactly one HTTP POST request (fire-and-forget — do not block the UI or wait for the response) to:

POST ${input.endpoint}
Headers:
  Content-Type: application/json
  Authorization: Bearer ${key}

Body (JSON), all field names exactly as written:
{
  "cartId": string,        // REQUIRED. Our own cart/checkout/session id. Must be stable and unique per cart so the same cart is never reported twice.
  "customerEmail": string, // REQUIRED. The customer's email address — this is the ONLY way the discount offer reaches them, so this field must never be empty or omitted.
  "customerName": string,  // optional
  "customerPhone": string, // Optional but STRONGLY recommended, E.164 (e.g. "+919876543210"). It is how this cart is matched to the same person's payment history, so that a checkout they already tried to pay for is recognised as a failed payment rather than an abandoned cart. Without it, matching falls back to the email alone, and a customer whose checkout email differs from the one their payment carried will be treated as two different people.
  "amountPaise": number    // REQUIRED. The cart total in PAISE, a whole integer — never rupees, never a decimal (e.g. ₹499 must be sent as 49900, not 499 or 499.00).
}

Find the right place to add this call in this codebase — most likely wherever cart or checkout state is already tracked (a cart page component, a checkout session handler, an unload/exit-intent listener, or a scheduled job that scans for idle carts) — and use whatever HTTP client this codebase already uses elsewhere, if there is one. Do not modify any existing checkout, payment, or order logic — this is purely an additional, non-blocking notification alongside it. Do not send this webhook for a cart that has already been paid for.`;
}
