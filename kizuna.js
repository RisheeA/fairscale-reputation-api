// =============================================================================
// KIZUNA MVP — FairScale x Kamiyo Credit Trust System
// =============================================================================
// Closed-loop trust and underwriting for Kizuna.
// FairScale: attestation (trust events), scoring (KizunaFairScore), underwriting (decisions)
// Kamiyo: enforcement (payments, collateral, settlement, disputes)
//
// MVP constraints:
// - No unsecured lending
// - Enterprise lane = prefunded only
// - Crypto-fast lane = overcollateralized only
// - All decisions fail closed on missing/invalid data
// =============================================================================

// ---------------------------------------------------------------------------
// KIZUNA DATA STORES
// ---------------------------------------------------------------------------

const KIZUNA = {
  // Trust events — append-only log, keyed by eventId for idempotency
  events: new Map(),          // eventId -> TrustEvent
  // Per-entity event index — fast lookup
  eventsByEntity: new Map(),  // entityId -> [eventId, eventId, ...]
  // KizunaFairScore cache — wallet/agent -> scored object
  scores: new Map(),          // entityId -> { score, band, components, reasons, ... }
  // Underwriting decisions — nonce-keyed for replay protection
  decisions: new Map(),       // nonce -> DecisionEnvelope
  // Policy config
  policy: {
    version: 'kizuna-mvp-1.0',
    updated_at: new Date().toISOString(),
  },
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const KIZUNA_EVENT_TYPES = new Set([
  'service_completed',
  'service_refunded',
  'settlement_confirmed',
  'repayment_received',
  'default_recorded',
  'dispute_opened',
  'dispute_won',
  'dispute_lost',
  'merchant_verified',
  'identity_verified',
  // Collateral and refund events (Kamiyo enforcement feedback)
  'collateral_deposited',
  'collateral_withdrawn',
  'refund_issued',
]);

const RISK_BANDS = {
  PRIME:    { min: 75, label: 'Prime',    color: 'green' },
  NEAR_PRIME: { min: 55, label: 'Near Prime', color: 'blue' },
  SUBPRIME: { min: 35, label: 'Subprime', color: 'yellow' },
  HIGH_RISK:{ min: 0,  label: 'High Risk', color: 'red' },
};

const REASON_CODES = {
  // Approval reasons
  STRONG_REPAYMENT_HISTORY: 'strong_repayment_history',
  NO_DEFAULTS: 'no_defaults',
  VERIFIED_MERCHANT: 'verified_merchant',
  VERIFIED_IDENTITY: 'verified_identity',
  HIGH_SERVICE_QUALITY: 'high_service_quality',
  LONG_TENURE: 'long_tenure',
  COLLATERAL_SUFFICIENT: 'collateral_sufficient',
  PREFUND_SUFFICIENT: 'prefund_sufficient',
  WITHIN_MANDATE_LIMITS: 'within_mandate_limits',
  // Denial reasons
  INSUFFICIENT_HISTORY: 'insufficient_history',
  RECENT_DEFAULT: 'recent_default',
  HIGH_DISPUTE_RATE: 'high_dispute_rate',
  SCORE_BELOW_THRESHOLD: 'score_below_threshold',
  EXCEEDS_MANDATE: 'exceeds_mandate',
  INSUFFICIENT_PREFUND: 'insufficient_prefund',
  INSUFFICIENT_COLLATERAL: 'insufficient_collateral',
  UNHEALTHY_LTV: 'unhealthy_ltv',
  MISSING_VERIFICATION: 'missing_verification',
  INVALID_LANE: 'invalid_lane',
  STALE_SCORE: 'stale_score',
  OUTSTANDING_EXCEEDS_LIMIT: 'outstanding_exceeds_limit',
  NONCE_REPLAY: 'nonce_replay',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
};

// ---------------------------------------------------------------------------
// 1. TRUST EVENT INGESTION (Attestation Layer)
// ---------------------------------------------------------------------------

function validateTrustEvent(event) {
  const errors = [];
  if (!event.eventId) errors.push('missing eventId');
  if (!event.type || !KIZUNA_EVENT_TYPES.has(event.type)) errors.push(`invalid type: ${event.type}`);
  if (!event.entityId) errors.push('missing entityId (wallet or agentId)');
  if (!event.timestamp) errors.push('missing timestamp');
  if (!event.signature) errors.push('missing signature');
  if (!event.source) errors.push('missing source');
  return errors;
}

function ingestTrustEvent(event) {
  // Idempotency check — same eventId = skip
  if (KIZUNA.events.has(event.eventId)) {
    return { accepted: false, reason: 'duplicate_event', eventId: event.eventId };
  }

  const errors = validateTrustEvent(event);
  if (errors.length > 0) {
    return { accepted: false, reason: 'validation_failed', errors };
  }

  // Store event
  const stored = {
    ...event,
    ingestedAt: new Date().toISOString(),
    policyVersion: KIZUNA.policy.version,
  };
  KIZUNA.events.set(event.eventId, stored);

  // Index by entity
  const entityEvents = KIZUNA.eventsByEntity.get(event.entityId) || [];
  entityEvents.push(event.eventId);
  KIZUNA.eventsByEntity.set(event.entityId, entityEvents);

  // Invalidate cached score for this entity
  KIZUNA.scores.delete(event.entityId);

  // Feed back into main FairScale scoring — invalidate the agent cache
  // so the next time this wallet is scored, it picks up the new trust data.
  // Events like repayment_received, default_recorded, dispute_lost directly
  // affect the Kamiyo reliability metrics which feed into the Agent FairScore.
  if (KIZUNA._registry?.agents) {
    KIZUNA._registry.agents.delete(event.entityId);
  }

  return { accepted: true, eventId: event.eventId, ingestedAt: stored.ingestedAt };
}

function getEntityEvents(entityId, options = {}) {
  const eventIds = KIZUNA.eventsByEntity.get(entityId) || [];
  let events = eventIds.map(id => KIZUNA.events.get(id)).filter(Boolean);

  // Filter by type
  if (options.type) {
    const types = Array.isArray(options.type) ? options.type : [options.type];
    events = events.filter(e => types.includes(e.type));
  }

  // Filter by time range
  if (options.since) {
    const since = new Date(options.since).getTime();
    events = events.filter(e => new Date(e.timestamp).getTime() >= since);
  }

  // Sort by timestamp descending (most recent first)
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limit
  if (options.limit) events = events.slice(0, options.limit);

  return events;
}

// ---------------------------------------------------------------------------
// 2. KIZUNA FAIRSCORE (Scoring Engine)
// ---------------------------------------------------------------------------
// Separate from the Agent FairScore in the directory.
// This score is specifically tuned for credit/underwriting decisions.
//
// Weighting:
//   30% repayment and settlement performance
//   25% dispute / default behavior
//   20% merchant / counterparty verification quality
//   15% service quality and refund behavior
//   10% tenure and activity consistency

function calculateKizunaFairScore(entityId) {
  const events = getEntityEvents(entityId);
  const reasons = [];
  const components = {};

  // If no events at all, return minimal score
  if (events.length === 0) {
    return {
      entityId,
      score: 10,
      band: 'HIGH_RISK',
      bandLabel: RISK_BANDS.HIGH_RISK.label,
      confidence: 0,
      components: { repayment: 0, disputes: 0, verification: 0, serviceQuality: 0, tenure: 0 },
      reasons: [REASON_CODES.INSUFFICIENT_HISTORY],
      eventCount: 0,
      policyVersion: KIZUNA.policy.version,
      scoredAt: new Date().toISOString(),
    };
  }

  // Count event types
  const counts = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }

  const totalEvents = events.length;
  const oldestEvent = events[events.length - 1];
  const newestEvent = events[0];
  const tenureDays = oldestEvent ? (Date.now() - new Date(oldestEvent.timestamp).getTime()) / (1000 * 60 * 60 * 24) : 0;

  // --- 30% Repayment & Settlement Performance ---
  const repayments = counts.repayment_received || 0;
  const settlements = counts.settlement_confirmed || 0;
  const defaults = counts.default_recorded || 0;
  const totalRepayable = repayments + settlements + defaults;

  let repaymentScore = 50; // Neutral start
  if (totalRepayable > 0) {
    const successRate = (repayments + settlements) / totalRepayable;
    repaymentScore = Math.round(successRate * 100);
    if (successRate >= 0.95) reasons.push(REASON_CODES.STRONG_REPAYMENT_HISTORY);
    if (defaults === 0 && totalRepayable >= 3) reasons.push(REASON_CODES.NO_DEFAULTS);
    if (defaults > 0) reasons.push(REASON_CODES.RECENT_DEFAULT);
  }
  components.repayment = repaymentScore;

  // --- 25% Dispute / Default Behavior ---
  const disputesOpened = counts.dispute_opened || 0;
  const disputesWon = counts.dispute_won || 0;
  const disputesLost = counts.dispute_lost || 0;
  const totalDisputes = disputesOpened;

  let disputeScore = 80; // Neutral-positive (no disputes = good)
  if (totalDisputes > 0) {
    const disputeRate = totalDisputes / Math.max(totalEvents, 1);
    const lossRate = disputesLost / Math.max(totalDisputes, 1);

    if (disputeRate > 0.3) { disputeScore = 10; reasons.push(REASON_CODES.HIGH_DISPUTE_RATE); }
    else if (disputeRate > 0.15) { disputeScore = 30; reasons.push(REASON_CODES.HIGH_DISPUTE_RATE); }
    else if (disputeRate > 0.05) { disputeScore = 50; }
    else { disputeScore = 70; }

    // Winning disputes is neutral/positive; losing is negative
    if (lossRate > 0.5) disputeScore = Math.max(disputeScore - 15, 0);
    if (lossRate === 0 && totalDisputes >= 2) disputeScore = Math.min(disputeScore + 10, 100);
  }
  if (defaults > 0) {
    // Defaults are the worst signal
    const defaultPenalty = Math.min(defaults * 20, 60);
    disputeScore = Math.max(disputeScore - defaultPenalty, 0);
  }
  components.disputes = disputeScore;

  // --- 20% Verification Quality ---
  const merchantVerified = counts.merchant_verified || 0;
  const identityVerified = counts.identity_verified || 0;

  let verificationScore = 20; // Base for unknown
  if (identityVerified > 0) { verificationScore += 40; reasons.push(REASON_CODES.VERIFIED_IDENTITY); }
  if (merchantVerified > 0) { verificationScore += 30; reasons.push(REASON_CODES.VERIFIED_MERCHANT); }
  // Also check existing FairScale verification
  const agentData = KIZUNA._registry?.agents?.get(entityId);
  if (agentData?.verifications?.said_onchain) verificationScore += 5;
  if (agentData?.verifications?.erc8004) verificationScore += 5;
  if (agentData?.verifications?.clawkey?.verified) verificationScore += 10;
  verificationScore = Math.min(verificationScore, 100);
  components.verification = verificationScore;

  // --- 15% Service Quality & Refund Behavior ---
  const servicesCompleted = counts.service_completed || 0;
  const servicesRefunded = counts.service_refunded || 0;
  const totalServices = servicesCompleted + servicesRefunded;

  let serviceScore = 50; // Neutral
  if (totalServices > 0) {
    const completionRate = servicesCompleted / totalServices;
    serviceScore = Math.round(completionRate * 100);
    if (completionRate >= 0.9 && totalServices >= 5) reasons.push(REASON_CODES.HIGH_SERVICE_QUALITY);
  }
  components.serviceQuality = serviceScore;

  // --- 10% Tenure & Activity Consistency ---
  let tenureScore = 20; // New entity
  if (tenureDays >= 180) { tenureScore = 90; reasons.push(REASON_CODES.LONG_TENURE); }
  else if (tenureDays >= 90) { tenureScore = 70; }
  else if (tenureDays >= 30) { tenureScore = 50; }
  else if (tenureDays >= 7) { tenureScore = 35; }

  // Activity consistency — events per month
  const monthsActive = Math.max(tenureDays / 30, 1);
  const eventsPerMonth = totalEvents / monthsActive;
  if (eventsPerMonth >= 10) tenureScore = Math.min(tenureScore + 10, 100);
  components.tenure = tenureScore;

  // --- Composite Score ---
  const rawScore = (
    (repaymentScore * 0.30) +
    (disputeScore * 0.25) +
    (verificationScore * 0.20) +
    (serviceScore * 0.15) +
    (tenureScore * 0.10)
  );

  const score = Math.max(Math.min(Math.round(rawScore), 100), 5);

  // Confidence: based on event count and tenure
  let confidence = 0;
  if (totalEvents >= 20 && tenureDays >= 60) confidence = 0.9;
  else if (totalEvents >= 10 && tenureDays >= 30) confidence = 0.7;
  else if (totalEvents >= 5) confidence = 0.5;
  else if (totalEvents >= 1) confidence = 0.3;

  // Risk band
  let band = 'HIGH_RISK';
  if (score >= RISK_BANDS.PRIME.min) band = 'PRIME';
  else if (score >= RISK_BANDS.NEAR_PRIME.min) band = 'NEAR_PRIME';
  else if (score >= RISK_BANDS.SUBPRIME.min) band = 'SUBPRIME';

  const result = {
    entityId,
    score,
    band,
    bandLabel: RISK_BANDS[band].label,
    confidence,
    components,
    reasons,
    eventCount: totalEvents,
    tenureDays: Math.round(tenureDays),
    policyVersion: KIZUNA.policy.version,
    scoredAt: new Date().toISOString(),
  };

  // Cache
  KIZUNA.scores.set(entityId, result);
  return result;
}

// ---------------------------------------------------------------------------
// 3. UNDERWRITING DECISION ENGINE
// ---------------------------------------------------------------------------

function evaluateDecision(request) {
  const {
    agentId,
    payerWallet,
    repayWallet,
    lane,                   // 'enterprise' | 'crypto_fast'
    network,
    requestedAmount,
    outstandingAmount,
    mandateLimits,          // { maxSingle, maxOutstanding, maxDaily }
    prefundBalance,         // For enterprise lane
    collateral,             // { amount, asset, ltv, healthFactor } for crypto-fast
    nonce,
  } = request;

  // --- Fail-closed: reject if critical fields missing ---
  const errors = [];
  if (!agentId) errors.push('missing agentId');
  if (!payerWallet) errors.push('missing payerWallet');
  if (!lane) errors.push('missing lane');
  if (requestedAmount == null || requestedAmount <= 0) errors.push('invalid requestedAmount');
  if (!nonce) errors.push('missing nonce');
  if (errors.length > 0) {
    return buildDecisionEnvelope({
      approved: false,
      approvedAmount: 0,
      reasonCodes: errors,
      nonce,
      agentId,
      lane,
    });
  }

  // --- Nonce replay protection ---
  if (KIZUNA.decisions.has(nonce)) {
    return { ...KIZUNA.decisions.get(nonce), replayed: true };
  }

  // --- Score the entity ---
  const fairScore = calculateKizunaFairScore(agentId);
  const reasonCodes = [];
  let approved = true;
  let approvedAmount = requestedAmount;

  // --- Lane-specific hard constraints ---
  if (lane === 'enterprise') {
    // Enterprise = prefunded only
    if (prefundBalance == null || prefundBalance <= 0) {
      approved = false;
      reasonCodes.push(REASON_CODES.INSUFFICIENT_PREFUND);
    } else if (prefundBalance < requestedAmount) {
      // Partial approval up to prefund balance
      approvedAmount = prefundBalance;
      reasonCodes.push(REASON_CODES.PREFUND_SUFFICIENT);
    } else {
      reasonCodes.push(REASON_CODES.PREFUND_SUFFICIENT);
    }
  } else if (lane === 'crypto_fast') {
    // Crypto-fast = overcollateralized only
    if (!collateral || collateral.amount <= 0) {
      approved = false;
      reasonCodes.push(REASON_CODES.INSUFFICIENT_COLLATERAL);
    } else {
      const ltv = collateral.ltv || (requestedAmount / collateral.amount);
      const healthFactor = collateral.healthFactor || (collateral.amount / Math.max(requestedAmount, 1));

      // MVP: require overcollateralization (health factor > 1.25)
      if (healthFactor < 1.25) {
        approved = false;
        reasonCodes.push(REASON_CODES.UNHEALTHY_LTV);
      } else {
        reasonCodes.push(REASON_CODES.COLLATERAL_SUFFICIENT);
        // Cap approved amount to collateral-safe level
        const maxSafe = Math.floor(collateral.amount / 1.25);
        if (requestedAmount > maxSafe) {
          approvedAmount = maxSafe;
        }
      }
    }
  } else {
    approved = false;
    reasonCodes.push(REASON_CODES.INVALID_LANE);
  }

  // --- Mandate limit checks ---
  if (mandateLimits) {
    if (mandateLimits.maxSingle && approvedAmount > mandateLimits.maxSingle) {
      approvedAmount = mandateLimits.maxSingle;
      reasonCodes.push(REASON_CODES.WITHIN_MANDATE_LIMITS);
    }
    if (mandateLimits.maxOutstanding && (outstandingAmount || 0) + approvedAmount > mandateLimits.maxOutstanding) {
      const remaining = mandateLimits.maxOutstanding - (outstandingAmount || 0);
      if (remaining <= 0) {
        approved = false;
        reasonCodes.push(REASON_CODES.OUTSTANDING_EXCEEDS_LIMIT);
      } else {
        approvedAmount = Math.min(approvedAmount, remaining);
        reasonCodes.push(REASON_CODES.WITHIN_MANDATE_LIMITS);
      }
    }
  }

  // --- Score-based checks (soft gates — score informs, collateral enforces) ---
  const minScoreForLane = lane === 'enterprise' ? 25 : lane === 'crypto_fast' ? 20 : 30;

  if (fairScore.score < minScoreForLane) {
    approved = false;
    reasonCodes.push(REASON_CODES.SCORE_BELOW_THRESHOLD);
  }

  // Recent defaults = hard deny
  const recentDefaults = getEntityEvents(agentId, {
    type: 'default_recorded',
    since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (recentDefaults.length > 0) {
    approved = false;
    reasonCodes.push(REASON_CODES.RECENT_DEFAULT);
  }

  // High dispute rate = human review
  const recentDisputes = getEntityEvents(agentId, {
    type: ['dispute_opened', 'dispute_lost'],
    since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (recentDisputes.length >= 3) {
    reasonCodes.push(REASON_CODES.HUMAN_REVIEW_REQUIRED);
    // Don't auto-deny, but flag for review
  }

  // Score-based reasons
  if (fairScore.score >= 75) reasonCodes.push(REASON_CODES.STRONG_REPAYMENT_HISTORY);
  if (fairScore.components.verification >= 60) reasonCodes.push(REASON_CODES.VERIFIED_MERCHANT);

  // Stale score check
  if (fairScore.eventCount === 0) {
    reasonCodes.push(REASON_CODES.INSUFFICIENT_HISTORY);
  }

  // --- Build and store decision ---
  const envelope = buildDecisionEnvelope({
    approved,
    approvedAmount: approved ? approvedAmount : 0,
    fairScore: fairScore.score,
    riskBand: fairScore.band,
    confidence: fairScore.confidence,
    reasonCodes: [...new Set(reasonCodes)], // deduplicate
    nonce,
    agentId,
    lane,
    requestedAmount,
    components: fairScore.components,
  });

  KIZUNA.decisions.set(nonce, envelope);
  return envelope;
}

function buildDecisionEnvelope(params) {
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000); // 5 minute TTL

  return {
    approved: params.approved,
    approvedAmount: params.approvedAmount || 0,
    fairScore: params.fairScore || null,
    riskBand: params.riskBand || null,
    confidence: params.confidence || 0,
    reasonCodes: params.reasonCodes || [],
    policyPackId: KIZUNA.policy.version,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    nonce: params.nonce || null,
    agentId: params.agentId || null,
    lane: params.lane || null,
    requestedAmount: params.requestedAmount || null,
    components: params.components || null,
    // Signature placeholder — in production, sign with Ed25519 key
    signature: generateDecisionSignature(params),
  };
}

function generateDecisionSignature(params) {
  // HMAC-SHA256 signing for decision envelopes
  // Canonical payload: sorted JSON keys, deterministic
  const canonical = JSON.stringify({
    agentId: params.agentId,
    approved: params.approved,
    approvedAmount: params.approvedAmount,
    fairScore: params.fairScore,
    nonce: params.nonce,
  });
  return hmacSign(canonical);
}

// HMAC-SHA256 using Node crypto (available globally in Node 18+)
import { createHmac } from 'crypto';

function hmacSign(payload) {
  const secret = KIZUNA._config?.ADMIN_KEY || 'fairscale-kizuna-mvp';
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return 'fsig_hmac256_' + hmac.digest('hex');
}

// Verify an incoming event's HMAC signature from Kamiyo
// Canonical format: JSON.stringify with SORTED keys of { entityId, eventId, timestamp, type }
function verifyEventSignature(event) {
  if (!event.signature) return false;
  const canonical = JSON.stringify({
    entityId: event.entityId,
    eventId: event.eventId,
    timestamp: event.timestamp,
    type: event.type,
  });
  const expected = hmacSign(canonical);
  return event.signature === expected;
}

// ---------------------------------------------------------------------------
// 4. RELIABILITY SUMMARY
// ---------------------------------------------------------------------------

function getReliabilitySummary(entityId) {
  const events = getEntityEvents(entityId);
  if (events.length === 0) return { entityId, summary: 'no_history', events: 0 };

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

  const repayments = counts.repayment_received || 0;
  const settlements = counts.settlement_confirmed || 0;
  const defaults = counts.default_recorded || 0;
  const disputes = counts.dispute_opened || 0;
  const servicesCompleted = counts.service_completed || 0;
  const refunds = counts.service_refunded || 0;

  const totalRepayable = repayments + settlements + defaults;
  const repaymentRate = totalRepayable > 0 ? (repayments + settlements) / totalRepayable : null;
  const totalServices = servicesCompleted + refunds;
  const completionRate = totalServices > 0 ? servicesCompleted / totalServices : null;

  const oldest = events[events.length - 1];
  const newest = events[0];

  return {
    entityId,
    eventCount: events.length,
    eventBreakdown: counts,
    repaymentRate: repaymentRate != null ? Math.round(repaymentRate * 1000) / 10 : null,
    serviceCompletionRate: completionRate != null ? Math.round(completionRate * 1000) / 10 : null,
    defaultCount: defaults,
    disputeCount: disputes,
    disputeWinRate: disputes > 0 ? Math.round(((counts.dispute_won || 0) / disputes) * 1000) / 10 : null,
    firstEventAt: oldest?.timestamp || null,
    lastEventAt: newest?.timestamp || null,
    tenureDays: oldest ? Math.round((Date.now() - new Date(oldest.timestamp).getTime()) / (1000 * 60 * 60 * 24)) : 0,
  };
}

// ---------------------------------------------------------------------------
// 5. PERSISTENCE (extends existing saveState/loadState)
// ---------------------------------------------------------------------------

function saveKizunaState() {
  // Called from the main saveState — adds Kizuna data to the state file
  return {
    events: Object.fromEntries(KIZUNA.events),
    eventsByEntity: Object.fromEntries(
      Array.from(KIZUNA.eventsByEntity.entries()).map(([k, v]) => [k, v])
    ),
    decisions: Object.fromEntries(
      // Only keep decisions from last 24h to avoid bloat
      Array.from(KIZUNA.decisions.entries()).filter(([_, d]) =>
        Date.now() - new Date(d.issuedAt).getTime() < 24 * 60 * 60 * 1000
      )
    ),
    policy: KIZUNA.policy,
  };
}

function loadKizunaState(state) {
  if (!state) return;
  if (state.events) {
    for (const [k, v] of Object.entries(state.events)) KIZUNA.events.set(k, v);
  }
  if (state.eventsByEntity) {
    for (const [k, v] of Object.entries(state.eventsByEntity)) KIZUNA.eventsByEntity.set(k, v);
  }
  if (state.decisions) {
    for (const [k, v] of Object.entries(state.decisions)) KIZUNA.decisions.set(k, v);
  }
  if (state.policy) KIZUNA.policy = state.policy;
  console.log(`[Kizuna] Restored: ${KIZUNA.events.size} trust events, ${KIZUNA.eventsByEntity.size} entities, ${KIZUNA.decisions.size} decisions`);
}

// ---------------------------------------------------------------------------
// 6. API ROUTES
// ---------------------------------------------------------------------------

function registerKizunaRoutes(app, CONFIG, registry) {

  // Make REGISTRY and CONFIG available to scoring/signing functions
  if (registry) KIZUNA._registry = registry;
  if (CONFIG) KIZUNA._config = CONFIG;

  // --- Middleware: Kamiyo auth for write endpoints ---
  const kizunaAuth = (req, res, next) => {
    const key = req.headers['x-kizuna-key'] || req.body?.apiKey;
    if (key !== CONFIG.ADMIN_KEY) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid Kizuna API key' });
    }
    next();
  };

  // ===== POST /kizuna/trust-events =====
  // Ingest signed trust events from Kamiyo enforcement layer
  app.post('/kizuna/trust-events', kizunaAuth, (req, res) => {
    const { events } = req.body;

    // Support single event or batch
    const eventList = Array.isArray(events) ? events : (req.body.eventId ? [req.body] : []);

    if (eventList.length === 0) {
      return res.status(400).json({ error: 'missing_events', message: 'Provide events array or single event object' });
    }

    if (eventList.length > 100) {
      return res.status(400).json({ error: 'batch_too_large', message: 'Max 100 events per batch' });
    }

    const results = [];
    for (const event of eventList) {
      const result = ingestTrustEvent(event);
      results.push(result);
    }

    const accepted = results.filter(r => r.accepted).length;
    const rejected = results.filter(r => !r.accepted).length;

    console.log(`[Kizuna] Trust events: ${accepted} accepted, ${rejected} rejected`);

    res.json({
      accepted,
      rejected,
      total: eventList.length,
      results,
      policyVersion: KIZUNA.policy.version,
    });
  });

  // ===== GET /kizuna/fairscore/:entityId =====
  // Get current KizunaFairScore for a wallet or agent
  app.get('/kizuna/fairscore/:entityId', (req, res) => {
    const { entityId } = req.params;
    if (!entityId) return res.status(400).json({ error: 'missing_entityId' });

    const score = calculateKizunaFairScore(entityId);
    res.json(score);
  });

  // ===== POST /kizuna/decisions/evaluate =====
  // Underwriting decision — core endpoint for Kizuna lane approvals
  app.post('/kizuna/decisions/evaluate', kizunaAuth, (req, res) => {
    const startMs = Date.now();
    const decision = evaluateDecision(req.body);
    const latencyMs = Date.now() - startMs;

    console.log(`[Kizuna] Decision: ${decision.approved ? 'APPROVED' : 'DENIED'} | ${decision.agentId?.slice(0, 8)}... | ${decision.lane} | $${decision.requestedAmount} -> $${decision.approvedAmount} | ${latencyMs}ms | reasons: ${decision.reasonCodes.join(', ')}`);

    res.json({
      ...decision,
      meta: {
        provider: 'FairScale',
        product: 'Kizuna',
        version: KIZUNA.policy.version,
        latencyMs,
      },
    });
  });

  // ===== GET /kizuna/reliability/:entityId =====
  // Reliability summary for dashboards and trust profiles
  app.get('/kizuna/reliability/:entityId', (req, res) => {
    const { entityId } = req.params;
    if (!entityId) return res.status(400).json({ error: 'missing_entityId' });

    const reliability = getReliabilitySummary(entityId);
    const score = KIZUNA.scores.get(entityId) || calculateKizunaFairScore(entityId);

    res.json({
      ...reliability,
      fairScore: score.score,
      riskBand: score.band,
      bandLabel: score.bandLabel,
      confidence: score.confidence,
      policyVersion: KIZUNA.policy.version,
    });
  });

  // ===== GET /kizuna/events/:entityId =====
  // Recent trust event feed for an entity
  app.get('/kizuna/events/:entityId', (req, res) => {
    const { entityId } = req.params;
    const { type, since, limit } = req.query;

    const events = getEntityEvents(entityId, {
      type: type || undefined,
      since: since || undefined,
      limit: parseInt(limit) || 50,
    });

    res.json({
      entityId,
      total: events.length,
      events,
      policyVersion: KIZUNA.policy.version,
    });
  });

  // ===== GET /kizuna/decisions/:nonce =====
  // Retrieve a past decision by nonce (for audit / replay)
  app.get('/kizuna/decisions/:nonce', kizunaAuth, (req, res) => {
    const decision = KIZUNA.decisions.get(req.params.nonce);
    if (!decision) return res.status(404).json({ error: 'decision_not_found' });
    res.json(decision);
  });

  // ===== GET /kizuna/stats =====
  // System health for operator dashboard
  app.get('/kizuna/stats', (req, res) => {
    const eventCounts = {};
    for (const [_, event] of KIZUNA.events) {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    }

    const decisions = Array.from(KIZUNA.decisions.values());
    const approved = decisions.filter(d => d.approved).length;
    const denied = decisions.filter(d => !d.approved).length;

    // Reason code frequency
    const reasonFreq = {};
    for (const d of decisions) {
      for (const r of (d.reasonCodes || [])) {
        reasonFreq[r] = (reasonFreq[r] || 0) + 1;
      }
    }

    res.json({
      trustEvents: {
        total: KIZUNA.events.size,
        entities: KIZUNA.eventsByEntity.size,
        byType: eventCounts,
      },
      decisions: {
        total: decisions.length,
        approved,
        denied,
        approvalRate: decisions.length > 0 ? Math.round((approved / decisions.length) * 1000) / 10 : null,
        reasonFrequency: reasonFreq,
      },
      scores: {
        cached: KIZUNA.scores.size,
      },
      policy: KIZUNA.policy,
    });
  });

  // ===== GET /kizuna/policy =====
  // Current policy version and config
  app.get('/kizuna/policy', (req, res) => {
    res.json({
      policy: KIZUNA.policy,
      riskBands: RISK_BANDS,
      reasonCodes: REASON_CODES,
      eventTypes: Array.from(KIZUNA_EVENT_TYPES),
      scoreWeights: {
        repayment: 0.30,
        disputes: 0.25,
        verification: 0.20,
        serviceQuality: 0.15,
        tenure: 0.10,
      },
      laneRequirements: {
        enterprise: { type: 'prefund', minScore: 25 },
        crypto_fast: { type: 'collateral', minHealthFactor: 1.25, minScore: 20 },
      },
      signing: {
        algorithm: 'HMAC-SHA256',
        header: 'x-kizuna-key (shared secret for auth)',
        eventSignatureFormat: {
          description: 'HMAC-SHA256 of canonical JSON payload using shared secret',
          canonicalPayload: 'JSON.stringify({ entityId, eventId, timestamp, type }) — keys MUST be sorted alphabetically',
          output: 'fsig_hmac256_<hex digest>',
          example: 'Compute HMAC-SHA256(secret, \'{"entityId":"WALLET","eventId":"evt_1","timestamp":"2026-03-09T14:00:00.000Z","type":"repayment_received"}\') and prefix with fsig_hmac256_',
        },
        decisionSignatureFormat: {
          description: 'FairScale signs decision envelopes with HMAC-SHA256',
          canonicalPayload: 'JSON.stringify({ agentId, approved, approvedAmount, fairScore, nonce }) — keys sorted alphabetically',
          output: 'fsig_hmac256_<hex digest>',
        },
        note: 'For staging, event signature verification is optional (x-kizuna-key auth is sufficient). Start generating HMAC signatures now — we will enforce verification in production.',
      },
    });
  });

  console.log('[Kizuna] Routes registered: /kizuna/trust-events, /kizuna/fairscore/:id, /kizuna/decisions/evaluate, /kizuna/reliability/:id, /kizuna/events/:id, /kizuna/decisions/:nonce, /kizuna/stats, /kizuna/policy');
}

// Export for use in index.js
export {
  KIZUNA,
  registerKizunaRoutes,
  saveKizunaState,
  loadKizunaState,
  ingestTrustEvent,
  calculateKizunaFairScore,
  evaluateDecision,
  getReliabilitySummary,
  getEntityEvents,
  verifyEventSignature,
  hmacSign,
  KIZUNA_EVENT_TYPES,
  RISK_BANDS,
  REASON_CODES,
};
