/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: src/core/policy/table/*.yaml
 * Rebuild: npm run policy:build
 *
 * Committed so that src/core can import the table without reading the
 * filesystem, which core is not permitted to do. A test verifies this file
 * matches a fresh compile of the YAML.
 */

export const RAW_POLICY_ROWS: readonly unknown[] = [
  {
    "id": "catchall",
    "version": 1,
    "description": "Last-resort row. Reaches no customer; puts the case in front of a person and stops. Reaching this row is itself a defect worth investigating.\n",
    "match": {},
    "ladder": [
      {
        "at": "0m",
        "action": "escalate_to_human",
        "queue": "merchant_review",
        "note": "If this fires, a cause class is missing a ladder. The compiler should have caught it — investigate the table, not the case.\n"
      }
    ],
    "preconditions": [
      "order_unpaid"
    ],
    "abortOn": [
      "order_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 0,
    "holdoutEligible": false,
    "catchAll": true
  },
  {
    "id": "auth_friction.default",
    "version": 1,
    "description": "Class-level ladder for an incomplete authentication. One retry on the same rail, then a switch.\n",
    "match": {
      "causeClass": [
        "auth_friction"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "10m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "retry_same",
          "upi_intent"
        ]
      },
      {
        "at": "4h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "email",
          "sms"
        ],
        "intent": "final_reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "auth_friction.payment_timed_out",
    "version": 1,
    "description": "The customer ran out of time on the bank's challenge page. Often the page itself was slow, so the first touch is a straightforward \"pick up where you left off\" rather than anything implying they did something wrong.\n",
    "match": {
      "errorReason": "payment_timed_out",
      "causeClass": [
        "auth_friction"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "10m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "retry_same",
          "upi_intent"
        ]
      },
      {
        "at": "6h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "customer_input.default",
    "version": 1,
    "description": "Class-level ladder for a mistyped field. Opens immediately, closes quickly — two touches, because a third message about a typo is nagging.\n",
    "match": {
      "causeClass": [
        "customer_input"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "note": "Zero delay. They are looking at the error right now."
      },
      {
        "at": "45m",
        "action": "nudge",
        "channels": [
          "email",
          "whatsapp"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "customer_input.incorrect_otp",
    "version": 1,
    "description": "Usually a late OTP rather than a wrong one. The first touch offers a straight retry; the second deliberately moves them off the card, because diagnose.ts withdraws same-instrument retry after two attempts and a third wrong OTP commonly locks the card at the issuer.\n",
    "match": {
      "errorReason": "incorrect_otp",
      "causeClass": [
        "customer_input"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "retry_same",
          "upi_intent"
        ]
      },
      {
        "at": "30m",
        "action": "nudge",
        "channels": [
          "email",
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ],
        "note": "No retry_same on the second touch. If the OTP failed twice, sending them back for a third attempt risks costing them the card entirely.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "customer_input.incorrect_cvv",
    "version": 1,
    "description": "A mistyped CVV — the single most recoverable failure we see.",
    "match": {
      "errorReason": "incorrect_cvv",
      "causeClass": [
        "customer_input"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "retry_same",
          "upi_intent"
        ]
      },
      {
        "at": "45m",
        "action": "nudge",
        "channels": [
          "email",
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "funds_limits.default",
    "version": 1,
    "description": "Class-level ladder for a shortfall or a limit. Slow, patient, low-pressure.",
    "match": {
      "causeClass": [
        "funds_limits"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "3h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "switch_method",
        "note": "Three-hour floor for this class. Anything sooner is nagging, not helping."
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "funds_limits.insufficient_funds",
    "version": 1,
    "description": "Not enough balance. The alternates that matter are a different account over UPI, or spreading the cost — never pressure. The diagnosis has already stripped EMI from the rails on small tickets where it does not exist.\n",
    "match": {
      "errorReason": "insufficient_funds",
      "causeClass": [
        "funds_limits"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "3h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "switch_method"
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "reminder"
      },
      {
        "at": "3d",
        "action": "nudge",
        "channels": [
          "email",
          "sms"
        ],
        "intent": "final_reminder",
        "note": "Third touch lands near the next common salary-credit window. Stage 6 replaces this fixed offset with the payer's observed cycle.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "funds_limits.transaction_limit_exceeded",
    "version": 1,
    "description": "A per-transaction or daily cap was hit. One of the few genuinely deterministic retry windows we get: daily limits reset at midnight, so the second touch deliberately offers the same instrument again.\n",
    "match": {
      "errorReason": "transaction_limit_exceeded",
      "causeClass": [
        "funds_limits"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "3h",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent",
          "other_card"
        ],
        "note": "Immediate answer is a different rail, or splitting the payment."
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "retry_same",
          "upi_intent"
        ],
        "note": "Past midnight the original card's daily limit has reset, so retry_same is genuinely the best suggestion here — unusual for a declined card.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "instrument_dead.default",
    "version": 1,
    "description": "Class-level ladder for any unusable instrument. Switch rails, do not retry.",
    "match": {
      "causeClass": [
        "instrument_dead"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "5m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "note": "No `suggest` — inherit the rails the diagnosis already worked out, which account for the failing method (e.g. a dead VPA never gets offered UPI).\n"
      },
      {
        "at": "8h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "instrument_dead.card_expired",
    "version": 1,
    "description": "The card has expired. High volume, unambiguous, and the customer can fix it in ten seconds if we tell them what happened.\n",
    "match": {
      "errorReason": "card_expired",
      "causeClass": [
        "instrument_dead"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "4m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent",
          "other_card"
        ],
        "attachPaymentLink": true,
        "note": "Four minutes, not instantly: the no_live_attempt precondition holds this back if they are already mid-retry on another card.\n"
      },
      {
        "at": "6h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "email",
          "sms"
        ],
        "intent": "final_reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "instrument_dead.card_not_enrolled",
    "version": 1,
    "description": "The card is not enabled for online transactions. Enormous on Indian debit cards and almost always recoverable — but only with an educational message, because the customer has no idea this is a setting.\n",
    "match": {
      "errorReason": "card_not_enrolled",
      "causeClass": [
        "instrument_dead"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "4m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "bank_action_required",
        "suggest": [
          "upi_intent",
          "other_card"
        ],
        "note": "Explain the setting AND offer UPI. Most customers will take UPI now and fix the card later, which is the outcome we want.\n"
      },
      {
        "at": "8h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "instrument_dead.card_disabled_for_online_payments",
    "version": 1,
    "description": "Online payments are switched off on this card. Same shape as card_not_enrolled — fixable by the customer in their banking app, with UPI as the immediate answer.\n",
    "match": {
      "errorReason": "card_disabled_for_online_payments",
      "causeClass": [
        "instrument_dead"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "4m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "bank_action_required",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      },
      {
        "at": "8h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "instrument_dead.invalid_vpa",
    "version": 1,
    "description": "The UPI handle is deregistered or invalid. Deliberately carries no `suggest` block so it inherits the diagnosis rails, which have already stripped both UPI intent and UPI collect — offering either would point the customer back at the handle that just failed.\n",
    "match": {
      "errorReason": "invalid_vpa",
      "causeClass": [
        "instrument_dead"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "4m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method"
      },
      {
        "at": "8h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "intent_exit.default",
    "version": 1,
    "description": "Class-level ladder for a deliberate exit or an abandoned checkout. Low pressure, no urgency theatre, no discounting.\n",
    "match": {
      "causeClass": [
        "intent_exit"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "25m",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "cart_saved",
        "note": "Twenty-five minutes. Long enough that we are not chasing someone who stepped away for a moment to find their other card.\n"
      },
      {
        "at": "6h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder"
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "email"
        ],
        "intent": "final_reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "intent_exit.payment_cancelled",
    "version": 1,
    "description": "The customer cancelled at the payment step — the highest-intent exit we see, because they had already chosen how to pay. Two touches, close together, then we leave them alone.\n",
    "match": {
      "errorReason": "payment_cancelled",
      "causeClass": [
        "intent_exit"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "25m",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "cart_saved",
        "suggest": [
          "retry_same",
          "upi_intent"
        ],
        "attachPaymentLink": true
      },
      {
        "at": "20h",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "email"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "merchant_config.default",
    "version": 1,
    "description": "Class-level ladder for a merchant-side configuration fault. Alerts the merchant with facts and rescues the affected customer onto a working rail.\n",
    "match": {
      "causeClass": [
        "merchant_config"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "merchant_alert",
        "severity": "critical",
        "minAffectedCases": 3,
        "note": "Three cases before firing, so a single odd request does not page anyone. The alert states what broke, when it started, and the normal baseline — and stops there.\n"
      },
      {
        "at": "2m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent",
          "other_card"
        ],
        "note": "Warm and blameless. Never names a fault, never says \"failed\", never suggests the customer did anything wrong — because they did not.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 1,
    "holdoutEligible": false
  },
  {
    "id": "merchant_config.bank_not_enabled",
    "version": 1,
    "description": "A payment method the merchant has not enabled. The highest-signal member of this class — it concentrates on one bank and one method, which makes the merchant alert unusually actionable.\n",
    "match": {
      "errorReason": "bank_not_enabled",
      "causeClass": [
        "merchant_config"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "merchant_alert",
        "severity": "critical",
        "minAffectedCases": 3
      },
      {
        "at": "2m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 1,
    "holdoutEligible": false
  },
  {
    "id": "merchant_config.merchant_not_activated",
    "version": 1,
    "description": "The merchant account itself is not live. Nothing can be recovered until a human fixes it, so this alerts hard and does not pretend otherwise.\n",
    "match": {
      "errorReason": "merchant_not_activated",
      "causeClass": [
        "merchant_config"
      ]
    },
    "ladder": [
      {
        "at": "0m",
        "action": "merchant_alert",
        "severity": "critical",
        "minAffectedCases": 1
      },
      {
        "at": "5m",
        "action": "escalate_to_human",
        "queue": "merchant_review"
      }
    ],
    "preconditions": [
      "order_unpaid"
    ],
    "abortOn": [
      "order_paid",
      "merchant_disconnected",
      "deadline_passed"
    ],
    "maxMessages": 0,
    "holdoutEligible": false
  },
  {
    "id": "risk.default",
    "version": 1,
    "description": "Class-level ladder for a risk or fraud decline. Exactly one touch, exactly one alternate rail, neutral framing.\n",
    "match": {
      "causeClass": [
        "risk"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "15m",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent"
        ],
        "attachPaymentLink": true,
        "note": "UPI only. Offering another card invites a second decline against the same risk profile, which is worse than saying nothing.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 1,
    "holdoutEligible": true
  },
  {
    "id": "risk.payment_risk_check_failed",
    "version": 1,
    "description": "An explicit fraud-system refusal. Same single touch as the class default, but escalated to a human review queue so the merchant can look at the pattern — a burst of these is a signal about the merchant's own risk rules, not about any one payer.\n",
    "match": {
      "errorReason": "payment_risk_check_failed",
      "causeClass": [
        "risk"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "15m",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "switch_method",
        "suggest": [
          "upi_intent"
        ]
      },
      {
        "at": "2h",
        "action": "escalate_to_human",
        "queue": "risk_review",
        "note": "Not a customer touch. Puts the case in front of a person, quietly."
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 1,
    "holdoutEligible": true
  },
  {
    "id": "terminal_noop.default",
    "version": 1,
    "description": "No revenue at risk. Do nothing at all — no ladder, no touches, no alert. Close the case and cancel everything already scheduled.\n",
    "match": {
      "causeClass": [
        "terminal_noop"
      ]
    },
    "ladder": [],
    "preconditions": [],
    "abortOn": [
      "order_paid",
      "deadline_passed"
    ],
    "maxMessages": 0,
    "holdoutEligible": false
  },
  {
    "id": "transient_infra.default",
    "version": 1,
    "description": "Class-level ladder for any transient bank or gateway failure. Waits on the downtime feed first, then re-engages once service is restored.\n",
    "match": {
      "causeClass": [
        "transient_infra"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "await_downtime_resolution",
        "timeout": "4h",
        "note": "Park until Razorpay reports the outage resolved, or four hours pass."
      },
      {
        "at": "25m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "retry_now_service_restored",
        "note": "Earliest permitted touch for this class is 20m — before that they may still be retrying and the bank is probably still down.\n"
      },
      {
        "at": "4h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "transient_infra.bank_technical_error",
    "version": 1,
    "description": "The customer's own bank had a technical problem. Highest-volume member of this class and the one most worth waiting out precisely.\n",
    "match": {
      "errorReason": "bank_technical_error",
      "causeClass": [
        "transient_infra"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "await_downtime_resolution",
        "timeout": "4h"
      },
      {
        "at": "20m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "retry_now_service_restored",
        "suggest": [
          "retry_same",
          "upi_intent"
        ],
        "note": "retry_same is legitimate here and nowhere in the dead-instrument classes — the card was never the problem.\n"
      },
      {
        "at": "3h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "reminder",
        "suggest": [
          "upi_intent",
          "other_card"
        ]
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "email",
          "sms"
        ],
        "intent": "final_reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "transient_infra.bank_cutoff_in_progress",
    "version": 1,
    "description": "The bank's core banking system is in its nightly cutoff window. Deterministically time-bound, and always in the middle of the night — so we wait it out silently and never message during it.\n",
    "match": {
      "errorReason": "bank_cutoff_in_progress",
      "causeClass": [
        "transient_infra"
      ],
      "attended": true
    },
    "ladder": [
      {
        "at": "0m",
        "action": "await_downtime_resolution",
        "timeout": "6h",
        "note": "Cutoff windows resolve on their own. Nothing to say to the customer yet."
      },
      {
        "at": "8h",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "retry_now_service_restored",
        "note": "By now the window has closed and quiet hours have passed. The not_quiet_hours precondition defers this if it has not.\n"
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "email"
        ],
        "intent": "final_reminder"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "payment_link_paid",
      "customer_optout",
      "deadline_passed"
    ],
    "maxMessages": 2,
    "holdoutEligible": true
  },
  {
    "id": "unattended.mandate_retry",
    "version": 1,
    "description": "Re-present a mandated debit that failed for a recoverable reason, with the required pre-debit notice ahead of each attempt and one human touch in between.\n",
    "match": {
      "causeClass": [
        "funds_limits",
        "transient_infra",
        "auth_friction"
      ],
      "attended": false
    },
    "ladder": [
      {
        "at": "0m",
        "action": "send_pre_debit_notice",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "leadTime": "24h",
        "note": "RBI pre-debit notification. Must precede the re-presentment."
      },
      {
        "at": "25h",
        "action": "retry_debit",
        "note": "Just past the 24h notice window. The mandate_active precondition re-checks the mandate is still valid before this fires.\n"
      },
      {
        "at": "26h",
        "action": "nudge",
        "channels": [
          "whatsapp"
        ],
        "intent": "subscription_at_risk",
        "note": "Only after the silent path has been tried. Recovering without ever bothering the customer is the highest-value outcome available.\n"
      },
      {
        "at": "3d",
        "action": "send_pre_debit_notice",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "leadTime": "24h"
      },
      {
        "at": "4d",
        "action": "retry_debit"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable",
      "mandate_active"
    ],
    "abortOn": [
      "order_paid",
      "customer_optout",
      "subscription_cancelled",
      "merchant_disconnected",
      "deadline_passed"
    ],
    "maxMessages": 3,
    "holdoutEligible": true
  },
  {
    "id": "unattended.no_retry",
    "version": 1,
    "description": "A mandated debit failed for a reason no re-presentment can fix — a typo, a dead instrument, a risk decline, a merchant misconfiguration, or a customer who cancelled. Re-presenting would burn attempts against something that cannot succeed, so this is a single human touch and nothing else.\n",
    "match": {
      "causeClass": [
        "customer_input",
        "instrument_dead",
        "risk",
        "merchant_config",
        "intent_exit"
      ],
      "attended": false
    },
    "ladder": [
      {
        "at": "25m",
        "action": "nudge",
        "channels": [
          "whatsapp",
          "sms"
        ],
        "intent": "subscription_at_risk",
        "note": "No `suggest` — inherit the diagnosis rails, which already exclude anything the cause class forbids. One touch only: the ceiling here is the strictest of the five classes this row covers.\n"
      }
    ],
    "preconditions": [
      "order_unpaid",
      "no_live_attempt",
      "consent_ok",
      "not_quiet_hours",
      "within_frequency_cap",
      "channel_deliverable"
    ],
    "abortOn": [
      "order_paid",
      "customer_optout",
      "subscription_cancelled",
      "merchant_disconnected",
      "deadline_passed"
    ],
    "maxMessages": 1,
    "holdoutEligible": true
  }
];
