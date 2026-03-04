import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  FAIRSCALE_API: 'https://api.fairscale.xyz',
  FAIRSCALE_API_KEY: process.env.FAIRSCALE_API_KEY,
  SAID_API: 'https://api.saidprotocol.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  HELIUS_RPC: 'https://mainnet.helius-rpc.com',
  PAYMENT_ADDRESS: 'fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  VERIFICATION_AMOUNT: 5,
  PORT: process.env.PORT || 8080,
  ERC8004_REGISTRY_PROGRAM: '8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ',
  SAID_PROGRAM: '5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G',
  CLAWKEY_API: 'https://clawkey.ai/api',
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),
  services: new Map(),
  verifiedWallets: new Map(),
  erc8004Agents: new Map(),
  erc8004ByWallet: new Map(),
  saidAgents: new Map(),
  lastErc8004Sync: null,
  lastSaidSync: null,
};

// =============================================================================
// UTILITY: BASE58 ENCODER
// =============================================================================

function encodeBase58(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let str = '';
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str;
}

// =============================================================================
// API CLIENTS
// =============================================================================

async function getFairScaleScore(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.FAIRSCALE_API}/score?wallet=${encodeURIComponent(wallet)}`,
      { headers: { accept: 'application/json', fairkey: CONFIG.FAIRSCALE_API_KEY } }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (e) { console.error('FairScale error:', e.message); return null; }
}

async function getSAIDData(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.SAID_API}/api/verify/${encodeURIComponent(wallet)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (e) { console.error('SAID error:', e.message); return null; }
}

async function getClawKeyVerification(deviceIdOrPubkey) {
  try {
    const response = await fetch(
      `${CONFIG.CLAWKEY_API}/verify/${encodeURIComponent(deviceIdOrPubkey)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const d = await response.json();
    return { registered: d.registered || false, verified: d.verified || false, humanId: d.humanId || null, registeredAt: d.registeredAt || null };
  } catch (e) { console.error('[ClawKey] Error:', e.message); return null; }
}

// =============================================================================
// SAID PROTOCOL - ON-CHAIN REGISTRY SYNC
// =============================================================================

async function fetchSAIDAgentsOnChain(limit = 2000) {
  if (!CONFIG.HELIUS_API_KEY) { console.warn('[SAID On-Chain] No HELIUS_API_KEY'); return []; }
  try {
    const response = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [CONFIG.SAID_PROGRAM, { encoding: 'base64', commitment: 'confirmed' }] })
    });
    if (!response.ok) { console.error('[SAID On-Chain] RPC error:', response.status); return []; }
    const result = await response.json();
    if (result.error) { console.error('[SAID On-Chain] RPC error:', result.error.message); return []; }
    const accounts = result.result || [];
    console.log(`[SAID On-Chain] Found ${accounts.length} program accounts`);

    // Step 1: Analyze account sizes to understand the data model
    const sizeBuckets = {};
    for (const account of accounts) {
      const data = account.account?.data;
      if (Array.isArray(data) && data[0]) {
        const len = Buffer.from(data[0], 'base64').length;
        sizeBuckets[len] = (sizeBuckets[len] || 0) + 1;
      }
    }
    const sortedSizes = Object.entries(sizeBuckets).sort((a, b) => b[1] - a[1]);
    console.log(`[SAID On-Chain] Account size distribution: ${sortedSizes.slice(0, 5).map(([s, c]) => `${s}b×${c}`).join(', ')}`);

    // Step 2: Extract candidate wallets from ALL 32-byte aligned offsets after discriminator
    // Group by most common account sizes (likely agent identity PDAs)
    const candidateWallets = new Map(); // wallet -> { pda, offset, dataLength }
    for (const account of accounts) {
      try {
        const data = account.account?.data;
        if (!Array.isArray(data) || !data[0]) continue;
        const buffer = Buffer.from(data[0], 'base64');
        // For Anchor programs: 8-byte discriminator, then struct fields
        // Try offset 8 (first Pubkey field after discriminator - most common for owner/authority)
        if (buffer.length >= 40) {
          const pubkeyBytes = buffer.slice(8, 40);
          if (!pubkeyBytes.every(b => b === 0) && !pubkeyBytes.every(b => b === 0xFF)) {
            const wallet = encodeBase58(pubkeyBytes);
            if (wallet && wallet.length >= 32 && wallet.length <= 44) {
              candidateWallets.set(wallet, { pda: account.pubkey, dataLength: buffer.length, offset: 8 });
            }
          }
        }
      } catch (e) { /* skip */ }
    }
    console.log(`[SAID On-Chain] Extracted ${candidateWallets.size} unique candidate wallets from offset 8`);

    // Step 3: Batch validate candidates using getMultipleAccounts (100 at a time)
    // Real wallets will have lamports > 0 or exist on-chain; garbage addresses won't
    const allCandidates = [...candidateWallets.keys()];
    const validWallets = new Set();
    const batchSize = 100;
    for (let i = 0; i < allCandidates.length; i += batchSize) {
      const batch = allCandidates.slice(i, i + batchSize);
      try {
        const validateResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'base64', commitment: 'confirmed' }] })
        });
        const validateResult = await validateResponse.json();
        const accountResults = validateResult.result?.value || [];
        for (let j = 0; j < accountResults.length; j++) {
          if (accountResults[j] !== null) {
            validWallets.add(batch[j]);
          }
        }
      } catch (e) { console.warn('[SAID On-Chain] Batch validation error:', e.message); }
      await new Promise(resolve => setTimeout(resolve, 50)); // rate limit
    }
    console.log(`[SAID On-Chain] Validated ${validWallets.size}/${candidateWallets.size} wallets exist on-chain`);

    // Step 4: Return only validated wallets
    const agents = [];
    for (const [wallet, meta] of candidateWallets) {
      if (validWallets.has(wallet)) {
        agents.push({ pda: meta.pda, wallet, dataLength: meta.dataLength, layout: `offset-${meta.offset}` });
      }
      if (agents.length >= limit) break;
    }
    console.log(`[SAID On-Chain] Returning ${agents.length} validated agent wallets`);
    return agents;
  } catch (e) { console.error('[SAID On-Chain] Error:', e.message); return []; }
}

// =============================================================================
// ERC-8004 AGENT REGISTRY - MULTI-STRATEGY FETCH
// =============================================================================

async function fetch8004Agents(limit = 500) {
  if (!CONFIG.HELIUS_API_KEY) { console.warn('[8004] No HELIUS_API_KEY'); return []; }

  // Strategy 1: Find RegistryConfig PDA to get collection address
  let collectionAddress = null;
  try {
    const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [CONFIG.ERC8004_REGISTRY_PROGRAM, { encoding: 'base64', commitment: 'confirmed' }] })
    });
    const d = await r.json();
    const allAccounts = d.result || [];
    console.log(`[8004 Sync] Found ${allAccounts.length} total program accounts`);
    // Config PDA is the smallest account (< 100 bytes), agent PDAs are much larger
    const configAccounts = allAccounts
      .map(a => ({ pubkey: a.pubkey, buf: Buffer.from(a.account.data[0], 'base64') }))
      .filter(a => a.buf.length < 100 && a.buf.length >= 40)
      .sort((a, b) => a.buf.length - b.buf.length);
    console.log(`[8004 Sync] Found ${configAccounts.length} config-sized PDAs (< 100 bytes)`);
    if (configAccounts.length > 0) {
      const buf = configAccounts[0].buf;
      collectionAddress = encodeBase58(buf.slice(8, 40));
      console.log(`[8004 Sync] Collection address: ${collectionAddress} (from ${buf.length}-byte PDA)`);
    }
  } catch (e) { console.warn('[8004] Config lookup failed:', e.message); }

  // Strategy 2: getAssetsByGroup with collection
  if (collectionAddress) {
    try {
      const agents = [];
      let page = 1, hasMore = true;
      while (hasMore && agents.length < limit) {
        const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetsByGroup', params: { groupKey: 'collection', groupValue: collectionAddress, page, limit: 100 } })
        });
        const items = (await r.json()).result?.items || [];
        if (items.length === 0) break;
        for (const item of items) { const a = parse8004Asset(item); if (a) agents.push(a); }
        page++;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      console.log(`[8004 Sync] getAssetsByGroup: ${agents.length} agents`);
      if (agents.length > 0) return agents;
    } catch (e) { console.warn('[8004] Collection fetch failed:', e.message); }
  }

  // Strategy 3: getAssetsByCreator
  try {
    const agents = [];
    let page = 1, hasMore = true;
    while (hasMore && agents.length < limit) {
      const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetsByCreator', params: { creatorAddress: CONFIG.ERC8004_REGISTRY_PROGRAM, page, limit: 100, onlyVerified: false } })
      });
      const items = (await r.json()).result?.items || [];
      if (items.length === 0) break;
      for (const item of items) { const a = parse8004Asset(item); if (a) agents.push(a); }
      page++;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    console.log(`[8004 Sync] getAssetsByCreator: ${agents.length} agents`);
    if (agents.length > 0) return agents;
  } catch (e) { console.warn('[8004] Creator fetch failed:', e.message); }

  // Strategy 4: Raw getProgramAccounts
  try {
    const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [CONFIG.ERC8004_REGISTRY_PROGRAM, { encoding: 'base64', commitment: 'confirmed' }] })
    });
    const accounts = (await r.json()).result || [];
    console.log(`[8004 Sync] getProgramAccounts: ${accounts.length} accounts`);
    const agents = [];
    for (const account of accounts) {
      try {
        const buf = Buffer.from(account.account.data[0], 'base64');
        if (buf.length >= 72) {
          const ownerWallet = encodeBase58(buf.slice(8, 40));
          const assetId = encodeBase58(buf.slice(40, 72));
          if (ownerWallet && ownerWallet.length >= 32 && ownerWallet.length <= 44) {
            agents.push({ assetId: assetId || account.pubkey, wallet: ownerWallet, name: null, description: null, image: null, jsonUri: null, services: [], skills: [], rawMetadata: null, source: 'erc8004', fetchedAt: new Date().toISOString() });
          }
        }
      } catch (e) { /* skip */ }
      if (agents.length >= limit) break;
    }
    console.log(`[8004 Sync] Extracted ${agents.length} agents from PDAs`);
    return agents;
  } catch (e) { console.error('[8004] All methods failed:', e.message); return []; }
}

function parse8004Asset(item) {
  if (!item?.id) return null;
  const c = item.content || {};
  const m = c.metadata || {};
  return { assetId: item.id, wallet: item.ownership?.owner || null, name: m.name || null, description: m.description || null, image: c.links?.image || m.image || null, jsonUri: c.json_uri || '', services: [], skills: [], rawMetadata: null, source: 'erc8004', fetchedAt: new Date().toISOString() };
}

async function resolve8004Metadata(uri) {
  if (!uri) return null;
  try {
    let url = uri;
    if (uri.startsWith('ipfs://')) url = `https://gateway.pinata.cloud/ipfs/${uri.replace('ipfs://', '')}`;
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// =============================================================================
// SYNC FUNCTIONS
// =============================================================================

async function syncFrom8004() {
  console.log('[8004 Sync] Starting...');
  try {
    const rawAgents = await fetch8004Agents(2000);
    if (rawAgents.length === 0) { console.log('[8004 Sync] No agents found. Retry next cycle.'); return; }
    console.log(`[8004 Sync] Found ${rawAgents.length} agents, enriching...`);
    let imported = 0, enriched = 0, failed = 0, nullWallets = 0;
    for (const agent of rawAgents) {
      try {
        REGISTRY.erc8004Agents.set(agent.assetId, agent);
        if (agent.wallet) REGISTRY.erc8004ByWallet.set(agent.wallet, agent);
        if (agent.jsonUri) {
          const meta = await resolve8004Metadata(agent.jsonUri);
          if (meta) {
            Object.assign(agent, { rawMetadata: meta, name: meta.name || agent.name, description: meta.description || agent.description, image: meta.image || agent.image });
            if (Array.isArray(meta.services)) agent.services = meta.services.map(s => ({ name: s.name || s.type || 'unknown', endpoint: s.endpoint || s.value || '' }));
            if (Array.isArray(meta.skills)) agent.skills = meta.skills;
            enriched++;
          }
        }
        if (agent.wallet) {
          const existing = REGISTRY.agents.get(agent.wallet);
          const tag = { assetId: agent.assetId, name: agent.name, services: agent.services, skills: agent.skills };
          if (!existing || Date.now() - new Date(existing.lastUpdated).getTime() > 600000) {
            const scored = await getOrCreateAgent(agent.wallet);
            if (scored) { scored.erc8004 = tag; imported++; }
            else { failed++; }
          } else { existing.erc8004 = tag; imported++; }
        } else { nullWallets++; }
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (e) { failed++; console.error(`[8004 Sync] Error scoring agent:`, e.message); }
    }
    console.log(`[8004 Sync] Done: ${imported} scored, ${enriched} metadata, ${nullWallets} null wallets, ${failed} failed / ${rawAgents.length}`);
    REGISTRY.lastErc8004Sync = new Date().toISOString();
  } catch (e) { console.error('[8004 Sync] Error:', e.message); }
}

async function syncFromSAID() {
  console.log('[SAID Sync] Starting (on-chain PDA discovery via Helius)...');
  try {
    const onChainAgents = await fetchSAIDAgentsOnChain(2000);
    console.log(`[SAID Sync] Found ${onChainAgents.length} on-chain agent PDAs`);
    let imported = 0, failed = 0, skippedNull = 0;

    // Phase 1: Register all wallets in saidAgents map
    for (const agent of onChainAgents) {
      if (!agent.wallet) { failed++; continue; }
      REGISTRY.saidAgents.set(agent.wallet, { pda: agent.pda, layout: agent.layout, syncedAt: new Date().toISOString() });
    }
    console.log(`[SAID Sync] Phase 1: ${REGISTRY.saidAgents.size} wallets registered`);

    // Phase 2: Score each wallet via FairScale + SAID verify
    for (const [wallet] of REGISTRY.saidAgents) {
      try {
        const result = await getOrCreateAgent(wallet);
        if (result) imported++;
        else { skippedNull++; failed++; }
      } catch (e) { failed++; console.error(`[SAID Sync] Score failed for ${wallet.slice(0,8)}:`, e.message); }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    console.log(`[SAID Sync] Scoring: ${imported} imported, ${skippedNull} null responses, ${failed - skippedNull} errors`);

    console.log(`[SAID Sync] Complete: ${imported} imported, ${failed} failed, ${REGISTRY.saidAgents.size} total`);
    console.log(`[Registry] Total agents in memory: ${REGISTRY.agents.size} | SAID: ${REGISTRY.saidAgents.size} | 8004: ${REGISTRY.erc8004Agents.size}`);
    REGISTRY.lastSaidSync = new Date().toISOString();
  } catch (e) { console.error('[SAID Sync] Error:', e.message); }
}

// =============================================================================
// PAYMENT VERIFICATION
// =============================================================================

async function verifyPayment(senderWallet) {
  if (!CONFIG.HELIUS_API_KEY) return { verified: false, error: 'Not configured' };
  try {
    const sigR = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [CONFIG.PAYMENT_ADDRESS, { limit: 100 }] })
    });
    const sigs = (await sigR.json()).result || [];
    for (const sig of sigs) {
      const txR = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] })
      });
      const tx = (await txR.json()).result;
      if (!tx?.meta || tx.meta.err) continue;
      for (const post of (tx.meta.postTokenBalances || [])) {
        if (post.mint !== CONFIG.USDC_MINT || post.owner !== CONFIG.PAYMENT_ADDRESS) continue;
        const pre = (tx.meta.preTokenBalances || []).find(p => p.accountIndex === post.accountIndex);
        const preAmt = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        if (postAmt - preAmt >= CONFIG.VERIFICATION_AMOUNT) {
          const keys = tx.transaction?.message?.accountKeys || [];
          if (keys.some(k => (typeof k === 'string' ? k : k.pubkey) === senderWallet)) {
            return { verified: true, txSignature: sig.signature };
          }
        }
      }
    }
    return { verified: false, error: 'No payment found. Send $5 USDC and try again.' };
  } catch (e) { return { verified: false, error: e.message }; }
}

// =============================================================================
// SCORING
// =============================================================================

function scale(value, max, curve = 1.5) {
  const normalized = Math.min(value / max, 1);
  return Math.min(Math.max(Math.round(Math.pow(normalized, 1 / curve) * 100), 10), 100);
}

function clamp(v, min = 0, max = 100) { return Math.min(Math.max(Math.round(v), min), max); }

// =============================================================================
// TRUST SCORING ENGINE v3
// =============================================================================
// Six pillars — on-chain behavior PLUS verification & social:
//
//   Reliability (25%)      — behavioral consistency, no exploitative patterns
//   Track Record (15%)     — age × sustained activity, recency
//   Economic Stake (10%)   — skin in the game via real asset holdings
//   Ecosystem (10%)        — cross-protocol diversity
//   Verification (25%)     — SAID, ERC-8004, ClawKey, payment verification
//   Social & Reputation (15%) — FairScale social_score, badges, SAID attestations
//
// Plus: Red flag penalties (up to -15), Time decay multiplier (0.75 - 1.0)
// Plus: Percentile rankings computed across full registry population

function calculateAgentFeatures(fairscaleData) {
  const f = fairscaleData?.features || {};

  // --- RELIABILITY (25%) ---
  const conviction = clamp((f.conviction_ratio || 0) * 100, 10, 100);
  const noDumps = (f.no_instant_dumps === true || f.no_instant_dumps === 1 || f.no_instant_dumps >= 0.9) ? 100 : 20;
  const tempoCV = f.tempo_cv || 0;
  const tempoConsistency = clamp(100 - (tempoCV * 40), 10, 100);
  const burstRatio = f.burst_ratio || 0;
  const steadiness = clamp(100 - (burstRatio * 80), 10, 100);
  const netFlow = f.net_sol_flow_30d || 0;
  const flowScore = netFlow >= 0 ? clamp(60 + (netFlow * 2), 60, 100) : clamp(60 + (netFlow * 5), 10, 60);

  const reliability = clamp(
    (noDumps * 0.30) + (conviction * 0.25) + (tempoConsistency * 0.20) +
    (steadiness * 0.15) + (flowScore * 0.10),
    10, 100
  );

  // --- TRACK RECORD (15%) ---
  const ageDays = f.wallet_age_days || 0;
  const ageScore = scale(ageDays, 365, 1.6);
  const activeDays = f.active_days || 0;
  const activeScore = scale(activeDays, 180, 1.5);
  const activityRatio = ageDays > 0 ? Math.min(activeDays / ageDays, 1) : 0;
  const consistencyScore = clamp(activityRatio * 100, 10, 100);
  const holdDays = f.median_hold_days || 0;
  const holdScore = scale(holdDays, 60, 1.4);
  const gapHours = f.median_gap_hours || 0;
  let gapScore;
  if (gapHours <= 0.1) gapScore = 30;
  else if (gapHours <= 1) gapScore = 50;
  else if (gapHours <= 48) gapScore = 90;
  else if (gapHours <= 168) gapScore = 60;
  else gapScore = 30;

  const track_record = clamp(
    (ageScore * 0.30) + (activeScore * 0.25) + (consistencyScore * 0.20) +
    (holdScore * 0.15) + (gapScore * 0.10),
    10, 100
  );

  // --- ECONOMIC STAKE (10%) ---
  const stableScore = clamp(f.stable_percentile_score || 10, 10, 100);
  const solScore = clamp(f.native_sol_percentile || 10, 10, 100);
  const lstScore = clamp(f.lst_percentile_score || 10, 10, 100);
  const majorScore = clamp(f.major_percentile_score || 10, 10, 100);

  const economic_stake = clamp(
    (stableScore * 0.35) + (solScore * 0.25) + (lstScore * 0.25) + (majorScore * 0.15),
    10, 100
  );

  // --- ECOSYSTEM LEGITIMACY (10%) ---
  const diversity = scale(f.platform_diversity || 0, 8, 1.4);
  const txVolume = scale(f.tx_count || 0, 200, 1.8);

  const ecosystem = clamp(
    (diversity * 0.60) + (txVolume * 0.40),
    10, 100
  );

  return { reliability, track_record, economic_stake, ecosystem };
}

// --- VERIFICATION SCORE (25% of composite) ---
// This is the big one: protocol registrations and human verification
// are first-class trust signals, not just bonuses
function calculateVerificationScore(wallet, saidData, verifications) {
  let score = 0;
  let maxPossible = 0;

  // SAID Protocol on-chain PDA (registered as agent)
  maxPossible += 20;
  if (REGISTRY.saidAgents.has(wallet)) score += 20;

  // ERC-8004 Solana Agent Registry (registered, paid gas)
  maxPossible += 25;
  if (REGISTRY.erc8004ByWallet.has(wallet)) score += 25;

  // ClawKey human verification (strongest signal)
  maxPossible += 30;
  if (verifications?.clawkey?.verified) score += 30;

  // FairScale self-registration
  maxPossible += 5;
  if (REGISTRY.registeredAgents.has(wallet)) score += 5;

  // Payment verification ($5 USDC)
  maxPossible += 10;
  if (REGISTRY.verifiedWallets.has(wallet)) score += 10;

  // SAID reputation tier
  maxPossible += 10;
  if (saidData?.reputation?.trustTier === 'high') score += 10;
  else if (saidData?.reputation?.trustTier === 'medium') score += 5;

  // Dual-registry bonus (on both SAID + 8004 = extra trust)
  if (REGISTRY.saidAgents.has(wallet) && REGISTRY.erc8004ByWallet.has(wallet)) score += 10;

  // Normalize to 0-100
  return clamp((score / maxPossible) * 100, 0, 100);
}

// --- SOCIAL & REPUTATION SCORE (15% of composite) ---
// Uses FairScale's social_score, badges, and SAID attestations
function calculateSocialScore(fairscaleData, saidData) {
  const socialRaw = fairscaleData?.social_score || 0;  // 0-100 from FairScale API
  const badges = fairscaleData?.badges || [];
  const attestations = saidData?.reputation?.feedbackCount || 0;
  const saidRepScore = saidData?.reputation?.score || 0;

  // FairScale social score (community reviews, off-chain signals)
  const fsocialScore = clamp(socialRaw, 0, 100);

  // Badge count — each badge earned is a social proof signal
  const badgeScore = clamp(badges.length * 12, 0, 100);

  // SAID attestation count — direct peer vouching
  const attestScore = clamp(attestations * 8, 0, 100);

  // SAID reputation score (if available)
  const saidScore = clamp(saidRepScore, 0, 100);

  // Weighted blend: FairScale social dominates, attestations second
  if (saidRepScore > 0) {
    return clamp(
      (fsocialScore * 0.35) + (saidScore * 0.25) + (attestScore * 0.25) + (badgeScore * 0.15),
      0, 100
    );
  }
  return clamp(
    (fsocialScore * 0.55) + (attestScore * 0.25) + (badgeScore * 0.20),
    0, 100
  );
}

// --- RED FLAG DETECTION ---
// Returns a penalty from 0 (no flags) to -15 (severe)
function detectRedFlags(fairscaleData) {
  const f = fairscaleData?.features || {};
  let penalty = 0;
  const flags = [];

  // New wallet with very high volume = potential sybil/airdrop farmer
  const ageDays = f.wallet_age_days || 0;
  const txCount = f.tx_count || 0;
  if (ageDays < 7 && txCount > 100) {
    penalty -= 5;
    flags.push('new_wallet_high_volume');
  } else if (ageDays < 14 && txCount > 200) {
    penalty -= 3;
    flags.push('new_wallet_high_volume');
  }

  // Single protocol usage with high tx = bot (only flag if extremely concentrated)
  const diversity = f.platform_diversity || 0;
  if (diversity <= 1 && txCount > 100) {
    penalty -= 4;
    flags.push('single_protocol_bot');
  }

  // Extremely rapid transactions = spam bot
  const gapHours = f.median_gap_hours || 0;
  if (gapHours > 0 && gapHours < 0.05) {
    penalty -= 4;
    flags.push('spam_bot_speed');
  }

  // Instant dumps = exploitative
  if (f.no_instant_dumps === false || f.no_instant_dumps === 0) {
    penalty -= 3;
    flags.push('instant_dumps');
  }

  // Heavy SOL drain in last 30d = possible rug/exit
  const netFlow = f.net_sol_flow_30d || 0;
  if (netFlow < -10) {
    penalty -= 3;
    flags.push('heavy_sol_drain');
  }

  // Very high burst ratio = erratic, potentially manipulative
  const burstRatio = f.burst_ratio || 0;
  if (burstRatio > 0.85) {
    penalty -= 2;
    flags.push('high_burst_ratio');
  }

  return { penalty: Math.max(penalty, -15), flags };
}

// --- TIME DECAY ---
// Multiplier from 0.75 (stale) to 1.0 (fresh). Based on FairScale API timestamp
// and on-chain activity recency signals.
function calculateTimeDecay(fairscaleData) {
  const timestamp = fairscaleData?.timestamp;
  const gapHours = fairscaleData?.features?.median_gap_hours || 0;
  const activeDays = fairscaleData?.features?.active_days || 0;
  const ageDays = fairscaleData?.features?.wallet_age_days || 1;

  // How fresh is the FairScale scoring data?
  let dataFreshness = 1.0;
  if (timestamp) {
    const hoursOld = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
    if (hoursOld > 168) dataFreshness = 0.90;      // > 1 week old
    if (hoursOld > 720) dataFreshness = 0.85;       // > 30 days old
    if (hoursOld > 2160) dataFreshness = 0.80;      // > 90 days old
  }

  // How recently active is the wallet? (activity ratio as proxy)
  const activityRatio = ageDays > 0 ? activeDays / ageDays : 0;
  let activityDecay = 1.0;
  if (activityRatio < 0.01) activityDecay = 0.80;      // Almost never active
  else if (activityRatio < 0.05) activityDecay = 0.90;  // Rarely active
  else if (activityRatio < 0.10) activityDecay = 0.95;  // Occasionally active

  // Combined: take the lower (more conservative) decay
  return Math.max(Math.min(dataFreshness, activityDecay), 0.75);
}

// --- PERCENTILE RANKING ---
// Computes percentile rank across all scored agents in registry
function computePercentiles(wallet, features, agentFairScore) {
  const allAgents = Array.from(REGISTRY.agents.values());
  if (allAgents.length < 10) return null; // Not enough data

  const metrics = {
    agent_fairscore: agentFairScore,
    reliability: features.reliability,
    track_record: features.track_record,
    economic_stake: features.economic_stake,
    ecosystem: features.ecosystem,
  };

  const percentiles = {};
  for (const [key, value] of Object.entries(metrics)) {
    let belowCount = 0;
    let total = 0;
    for (const a of allAgents) {
      const cmp = key === 'agent_fairscore' ? a.scores?.agent_fairscore : a.features?.[key];
      if (cmp != null) {
        total++;
        if (cmp < value) belowCount++;
      }
    }
    percentiles[key] = total > 0 ? Math.round((belowCount / total) * 100) : null;
  }
  return percentiles;
}

function getFeatureDescription(feature, value) {
  const descs = {
    reliability: {
      high: 'Consistent behavior, no dumps, strong conviction',
      mid: 'Generally stable patterns with some variability',
      low: 'Erratic patterns or limited behavioral data'
    },
    track_record: {
      high: 'Established wallet with sustained, consistent activity',
      mid: 'Some track record, moderate activity history',
      low: 'New wallet or limited activity history'
    },
    economic_stake: {
      high: 'Significant holdings in SOL, stables, and LSTs',
      mid: 'Moderate token positions across asset classes',
      low: 'Minimal economic commitment on-chain'
    },
    ecosystem: {
      high: 'Active across multiple protocols and platforms',
      mid: 'Moderate cross-protocol activity',
      low: 'Limited to few protocols or low transaction volume'
    },
    verification: {
      high: 'Multi-protocol verified (SAID + 8004 + ClawKey)',
      mid: 'Registered on at least one agent protocol',
      low: 'No protocol registrations or verifications'
    },
    social: {
      high: 'Strong social reputation and peer attestations',
      mid: 'Some social signals and community presence',
      low: 'Limited social or community reputation'
    },
  };
  const tier = value >= 55 ? 'high' : value >= 25 ? 'mid' : 'low';
  return descs[feature]?.[tier] || '';
}

// =============================================================================
// AGENT FAIRSCORE COMPOSITE
// =============================================================================

function calculateAgentFairScore(fairscaleData, features, saidData, wallet, verifications = {}) {
  // FairScale combined score (includes social) as base reference
  const fsCombined = fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0;

  // Six-pillar trust composite with DYNAMIC WEIGHT REDISTRIBUTION
  // If social data is absent, redistribute that weight to verification + reliability
  const verificationScore = calculateVerificationScore(wallet, saidData, verifications);
  const socialScore = calculateSocialScore(fairscaleData, saidData);
  
  const hasSocialData = (fairscaleData?.social_score > 0) || (saidData?.reputation?.score > 0) || (fairscaleData?.badges?.length > 0);
  
  let weights;
  if (hasSocialData) {
    // Full six pillars
    weights = { verification: 0.25, reliability: 0.25, social: 0.15, track_record: 0.15, economic_stake: 0.10, ecosystem: 0.10 };
  } else {
    // No social data — redistribute 15% to verification (+5%), reliability (+5%), track_record (+5%)
    weights = { verification: 0.30, reliability: 0.30, social: 0, track_record: 0.20, economic_stake: 0.10, ecosystem: 0.10 };
  }

  const trustComposite = (
    (verificationScore * weights.verification) +
    (features.reliability * weights.reliability) +
    (socialScore * weights.social) +
    (features.track_record * weights.track_record) +
    (features.economic_stake * weights.economic_stake) +
    (features.ecosystem * weights.ecosystem)
  );

  // Blend: FairScale combined (35%) + our trust composite (65%)
  // Slightly more weight to our composite since we add verification + social + red flags
  let blended = (fsCombined * 0.35) + (trustComposite * 0.65);

  // Red flag penalties
  const { penalty, flags } = detectRedFlags(fairscaleData);
  blended += penalty;

  // Time decay
  const decay = calculateTimeDecay(fairscaleData);
  blended *= decay;

  const score = Math.max(Math.min(Math.round(blended), 100), 5);

  return {
    score,
    breakdown: {
      fs_combined: Math.round(fsCombined),
      trust_composite: Math.round(trustComposite),
      verification: Math.round(verificationScore),
      social: Math.round(socialScore),
      has_social_data: hasSocialData,
      weights_used: weights,
      reliability: features.reliability,
      track_record: features.track_record,
      economic_stake: features.economic_stake,
      ecosystem: features.ecosystem,
      red_flag_penalty: penalty,
      red_flags: flags,
      time_decay: decay,
    }
  };
}

function getRecommendationTier(score, verifications, wallet) {
  const isHumanVerified = verifications?.clawkey?.verified || false;
  const on8004 = REGISTRY.erc8004ByWallet.has(wallet);
  const onSaid = REGISTRY.saidAgents.has(wallet);
  const registryCount = (on8004 ? 1 : 0) + (onSaid ? 1 : 0);

  // Highly Recommended: high score + strong verification
  if (score >= 70 && isHumanVerified) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };
  if (score >= 65 && registryCount >= 2) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };
  if (score >= 75 && registryCount >= 1) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };

  // Recommended: decent score + some verification
  if (score >= 55 && (on8004 || isHumanVerified)) return { tier: 'recommended', label: 'Recommended', color: 'green' };
  if (score >= 50 && registryCount >= 1) return { tier: 'recommended', label: 'Recommended', color: 'green' };
  if (score >= 60) return { tier: 'recommended', label: 'Recommended', color: 'green' };

  // Acceptable: moderate score
  if (score >= 40) return { tier: 'acceptable', label: 'Acceptable', color: 'yellow' };
  if (score >= 25) return { tier: 'caution', label: 'Use with Caution', color: 'orange' };
  return { tier: 'unverified', label: 'Unverified', color: 'red' };
}

// =============================================================================
// AGENT MANAGEMENT
// =============================================================================

async function getOrCreateAgent(wallet) {
  if (REGISTRY.agents.has(wallet)) {
    const cached = REGISTRY.agents.get(wallet);
    if (Date.now() - new Date(cached.lastUpdated).getTime() < 1800000) return cached;
  }

  const [fairscaleData, saidData] = await Promise.all([
    getFairScaleScore(wallet),
    getSAIDData(wallet)
  ]);

  if (!fairscaleData && !saidData) {
    console.warn(`[Score] No data for ${wallet.slice(0,8)}... (both APIs returned null)`);
    return null;
  }

  const regData = REGISTRY.registeredAgents.get(wallet);

  // ClawKey verification
  const verifications = {};
  try {
    const deviceId = regData?.clawkeyDeviceId || null;
    if (deviceId) verifications.clawkey = await getClawKeyVerification(deviceId);
  } catch (e) { console.error('[Verifications]', e.message); }

  const features = calculateAgentFeatures(fairscaleData);
  const scoreResult = calculateAgentFairScore(fairscaleData, features, saidData, wallet, verifications);
  const agentFairScore = scoreResult.score;
  const breakdown = scoreResult.breakdown;
  const recommendation = getRecommendationTier(agentFairScore, verifications, wallet);
  const percentiles = computePercentiles(wallet, features, agentFairScore);

  // Restore 8004 metadata if available
  const erc8004Data = REGISTRY.erc8004ByWallet.get(wallet);
  const erc8004Tag = erc8004Data ? { assetId: erc8004Data.assetId, name: erc8004Data.name, services: erc8004Data.services || [], skills: erc8004Data.skills || [] } : null;

  const agent = {
    wallet,
    name: regData?.name || erc8004Data?.name || saidData?.identity?.name || null,
    description: regData?.description || erc8004Data?.description || saidData?.identity?.description || null,
    website: regData?.website || saidData?.identity?.website || null,
    mcp: regData?.mcp || saidData?.endpoints?.mcp || null,
    scores: {
      agent_fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore_base || fairscaleData?.fairscore || 0),
      social_score: Math.round(fairscaleData?.social_score || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: saidData?.reputation?.feedbackCount || 0,
    },
    breakdown,
    percentiles,
    recommendation,
    features: {
      ...features,
      verification: breakdown.verification,
      social: breakdown.social,
    },
    verifications: {
      clawkey: verifications.clawkey ? { verified: verifications.clawkey.verified, humanId: verifications.clawkey.humanId } : null,
      said_onchain: REGISTRY.saidAgents.has(wallet),
      erc8004: REGISTRY.erc8004ByWallet.has(wallet),
    },
    erc8004: erc8004Tag,
    badges: fairscaleData?.badges || [],
    red_flags: breakdown.red_flags,
    descriptions: {
      reliability: getFeatureDescription('reliability', features.reliability),
      track_record: getFeatureDescription('track_record', features.track_record),
      economic_stake: getFeatureDescription('economic_stake', features.economic_stake),
      ecosystem: getFeatureDescription('ecosystem', features.ecosystem),
      verification: getFeatureDescription('verification', breakdown.verification),
      social: getFeatureDescription('social', breakdown.social),
    },
    isRegistered: REGISTRY.registeredAgents.has(wallet),
    isSaidAgent: REGISTRY.saidAgents.has(wallet),
    isVerified: REGISTRY.verifiedWallets.has(wallet),
    services: Array.from(REGISTRY.services.values()).filter(s => s.wallet === wallet),
    lastUpdated: new Date().toISOString(),
  };

  REGISTRY.agents.set(wallet, agent);
  return agent;
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '13.1.0',
    description: 'The Trust & Discovery Layer for Solana AI Agents',
    api: { v1: { 'GET /v1/score?wallet=': 'Score any Solana wallet', 'POST /v1/score/batch': 'Score up to 25 wallets', 'GET /v1/health': 'Health check' } },
    endpoints: {
      'GET /score': 'Get agent score (legacy)', 'POST /register': 'Register agent (optional clawkeyDeviceId)',
      'POST /verify': 'Verify payment', 'POST /service': 'Register x402 service',
      'GET /services': 'List services',
      'GET /directory': 'Agent directory (?page=1&limit=25&source=8004|said|fairscale|both&sort=agent_fairscore|reliability|track_record|economic_stake|ecosystem|verification|social&search=...&recommendation=highly_recommended|recommended|acceptable)',
      'GET /leaderboard': 'Sub-score leaderboards (?metric=agent_fairscore|reliability|track_record|economic_stake|ecosystem|verification|social&limit=25)',
      'GET /stats': 'Registry stats', 'GET /8004/agents': 'List 8004 agents',
    },
    integrations: { erc8004: 'Solana Agent Registry', said: 'SAID Protocol (on-chain PDA)', clawkey: 'ClawKey / VeryAI', fairscale: 'FairScale Scoring Engine' },
  });
});

// --- Public Scoring API v1 ---

app.get('/v1/score', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'missing_wallet', message: 'Provide ?wallet=<solana_address>' });
  if (wallet.length < 32 || wallet.length > 44) return res.status(400).json({ error: 'invalid_wallet' });
  try {
    const agent = await getOrCreateAgent(wallet);
    if (!agent) return res.status(502).json({ error: 'scoring_unavailable', wallet });
    const score = agent.scores.agent_fairscore;
    const erc8004 = agent.erc8004 || null;
    res.json({
      wallet, fairscore: score, tier: score >= 70 ? 'gold' : score >= 40 ? 'silver' : 'bronze',
      recommendation: agent.recommendation,
      features: agent.features,
      breakdown: agent.breakdown,
      percentiles: agent.percentiles,
      red_flags: agent.red_flags,
      badges: agent.badges,
      signals: { fairscore_base: agent.scores.fairscore_base, social_score: agent.scores.social_score, said_score: agent.scores.said_score, said_trust_tier: agent.scores.said_trust_tier, attestations: agent.scores.attestations, is_registered: agent.isRegistered, is_verified: agent.isVerified, is_said_agent: agent.isSaidAgent, is_erc8004: !!erc8004, human_verified: agent.verifications?.clawkey?.verified || false },
      erc8004: erc8004 ? { asset_id: erc8004.assetId, name: erc8004.name, services: erc8004.services } : null,
      meta: { provider: 'FairScale', version: 'v1', scored_at: agent.lastUpdated, cache_ttl: 1800 },
    });
  } catch (e) { console.error('v1/score error:', e.message); res.status(500).json({ error: 'internal_error' }); }
});

app.post('/v1/score/batch', async (req, res) => {
  const { wallets } = req.body;
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) return res.status(400).json({ error: 'missing_wallets' });
  if (wallets.length > 25) return res.status(400).json({ error: 'too_many_wallets' });
  const results = [];
  for (const wallet of wallets) {
    if (!wallet || wallet.length < 32 || wallet.length > 44) { results.push({ wallet, error: 'invalid_wallet' }); continue; }
    try {
      const agent = await getOrCreateAgent(wallet);
      if (!agent) { results.push({ wallet, error: 'scoring_unavailable' }); continue; }
      const s = agent.scores.agent_fairscore;
      results.push({ wallet, fairscore: s, tier: s >= 70 ? 'gold' : s >= 40 ? 'silver' : 'bronze', features: agent.features });
    } catch (e) { results.push({ wallet, error: 'scoring_failed' }); }
  }
  res.json({ total: wallets.length, scored: results.filter(r => !r.error).length, results, meta: { provider: 'FairScale', version: 'v1', scored_at: new Date().toISOString() } });
});

app.get('/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'FairScale Scoring API', version: 'v1', uptime: Math.floor(process.uptime()), registry: { agents: REGISTRY.agents.size, erc8004: REGISTRY.erc8004Agents.size, said: REGISTRY.saidAgents.size, services: REGISTRY.services.size }, timestamp: new Date().toISOString() });
});

// --- Legacy score endpoint ---

app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  const agent = await getOrCreateAgent(wallet);
  if (!agent) return res.status(404).json({ error: 'Could not fetch data', wallet });
  res.json({ wallet, name: agent.name || `Agent ${wallet.slice(0, 8)}...`, description: agent.description, website: agent.website, mcp: agent.mcp, agent_fairscore: agent.scores.agent_fairscore, fairscore_base: agent.scores.fairscore_base, social_score: agent.scores.social_score, recommendation: agent.recommendation, features: agent.features, breakdown: agent.breakdown, percentiles: agent.percentiles, badges: agent.badges, red_flags: agent.red_flags, descriptions: agent.descriptions, said: { score: agent.scores.said_score, trustTier: agent.scores.said_trust_tier, feedbackCount: agent.scores.attestations }, verifications: agent.verifications, isRegistered: agent.isRegistered, isSaidAgent: agent.isSaidAgent, isVerified: agent.isVerified, services: agent.services });
});

// --- Registration ---

app.post('/register', async (req, res) => {
  const { wallet, name, description, website, mcp, clawkeyDeviceId } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

  let clawkeyResult = null;
  if (clawkeyDeviceId) {
    clawkeyResult = await getClawKeyVerification(clawkeyDeviceId);
    console.log(`[Register] ClawKey for ${wallet}: ${clawkeyResult?.verified ? 'VERIFIED' : 'not verified'}`);
  }

  REGISTRY.registeredAgents.set(wallet, { wallet, name, description, website, mcp, clawkeyDeviceId: clawkeyDeviceId || null, clawkeyVerified: clawkeyResult?.verified || false, registeredAt: new Date().toISOString() });
  REGISTRY.agents.delete(wallet);
  const agent = await getOrCreateAgent(wallet);
  res.json({ success: true, message: 'Agent registered', clawkey: clawkeyResult ? { verified: clawkeyResult.verified, humanId: clawkeyResult.humanId } : null, agent: agent ? { wallet, name: agent.name, agent_fairscore: agent.scores.agent_fairscore } : null });
});

// --- Services ---

app.post('/service', async (req, res) => {
  const { wallet, url, name, description, price, category } = req.body;
  if (!wallet || !url || !name) return res.status(400).json({ error: 'Missing wallet, url, or name' });
  const serviceId = `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  REGISTRY.services.set(serviceId, { id: serviceId, wallet, url, name, description: description || '', price: price || 'Contact', category: category || 'utility', network: 'solana', registeredAt: new Date().toISOString() });
  res.json({ success: true, serviceId, message: 'Service registered' });
});

app.get('/services', (req, res) => {
  res.json({ total: REGISTRY.services.size, network: 'solana', services: Array.from(REGISTRY.services.values()) });
});

// --- Verify payment ---

app.post('/verify', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  if (REGISTRY.verifiedWallets.has(wallet)) return res.json({ success: true, message: 'Already verified' });
  const result = await verifyPayment(wallet);
  if (result.verified) {
    REGISTRY.verifiedWallets.set(wallet, { verifiedAt: new Date().toISOString(), txSignature: result.txSignature });
    REGISTRY.agents.delete(wallet);
    return res.json({ success: true, message: '+8 score boost applied', txSignature: result.txSignature });
  }
  res.status(400).json({ success: false, error: result.error, paymentAddress: CONFIG.PAYMENT_ADDRESS });
});

// --- Directory ---

app.get('/directory', (req, res) => {
  const source = req.query.source;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 5), 100);
  const search = (req.query.search || '').toLowerCase().trim();
  const sortBy = req.query.sort || 'agent_fairscore'; // agent_fairscore, reliability, track_record, economic_stake, ecosystem, verification, social
  const minScore = parseInt(req.query.min_score) || 0;
  const tier = req.query.tier; // gold, silver, bronze
  const recommendation = req.query.recommendation; // highly_recommended, recommended, acceptable, caution, unverified

  let agents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered || a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet) || REGISTRY.saidAgents.has(a.wallet));

  // Source filter
  if (source === '8004') agents = agents.filter(a => !!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet));
  else if (source === 'said') agents = agents.filter(a => REGISTRY.saidAgents.has(a.wallet));
  else if (source === 'fairscale') agents = agents.filter(a => a.isRegistered);
  else if (source === 'both') agents = agents.filter(a => (!!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet)) && REGISTRY.saidAgents.has(a.wallet));

  // Search filter (wallet, name)
  if (search) {
    agents = agents.filter(a =>
      a.wallet.toLowerCase().includes(search) ||
      (a.name || '').toLowerCase().includes(search) ||
      (a.erc8004?.name || '').toLowerCase().includes(search)
    );
  }

  // Score filters
  if (minScore > 0) agents = agents.filter(a => a.scores.agent_fairscore >= minScore);
  if (tier === 'gold') agents = agents.filter(a => a.scores.agent_fairscore >= 70);
  else if (tier === 'silver') agents = agents.filter(a => a.scores.agent_fairscore >= 40 && a.scores.agent_fairscore < 70);
  else if (tier === 'bronze') agents = agents.filter(a => a.scores.agent_fairscore < 40);

  // Recommendation filter
  if (recommendation) agents = agents.filter(a => a.recommendation?.tier === recommendation);

  // Sort
  const sortFn = {
    agent_fairscore: (a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore,
    reliability: (a, b) => (b.features?.reliability || 0) - (a.features?.reliability || 0),
    track_record: (a, b) => (b.features?.track_record || 0) - (a.features?.track_record || 0),
    economic_stake: (a, b) => (b.features?.economic_stake || 0) - (a.features?.economic_stake || 0),
    ecosystem: (a, b) => (b.features?.ecosystem || 0) - (a.features?.ecosystem || 0),
    verification: (a, b) => (b.features?.verification || 0) - (a.features?.verification || 0),
    social: (a, b) => (b.features?.social || 0) - (a.features?.social || 0),
    fairscore_base: (a, b) => (b.scores?.fairscore_base || 0) - (a.scores?.fairscore_base || 0),
  }[sortBy] || sortFn.agent_fairscore;
  agents.sort(sortFn);

  const total = agents.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paged = agents.slice(offset, offset + limit);

  const result = paged.map((a, i) => {
    const onSaid = REGISTRY.saidAgents.has(a.wallet);
    const on8004 = !!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet);
    const sources = [];
    if (onSaid) sources.push('said');
    if (on8004) sources.push('erc8004');
    if (a.isRegistered) sources.push('fairscale');

    const boosts = {};
    if (onSaid) boosts.said_onchain = '+3';
    if (on8004) boosts.erc8004_registry = '+5';
    if (onSaid && on8004) boosts.dual_registry = '+3';
    if (a.isRegistered) boosts.fairscale_registered = '+2';
    if (a.isVerified) boosts.payment_verified = '+5';
    if (a.verifications?.clawkey?.verified) boosts.clawkey_human = '+10';
    if (a.scores?.said_score > 0) boosts.said_reputation = `+${Math.min((a.scores.attestations || 0) * 3, 12)}`;
    if (a.scores?.said_trust_tier === 'high') boosts.said_trust = '+4';

    return {
      rank: offset + i + 1,
      wallet: a.wallet,
      name: a.erc8004?.name || a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      agent_fairscore: a.scores.agent_fairscore,
      fairscore_base: a.scores.fairscore_base,
      recommendation: a.recommendation,
      features: a.features,
      isVerified: a.isVerified,
      humanVerified: a.verifications?.clawkey?.verified || false,
      services: a.services.length + (a.erc8004?.services?.length || 0),
      sources,
      boosts,
      said: onSaid ? { pda: REGISTRY.saidAgents.get(a.wallet)?.pda || null, score: a.scores.said_score, trustTier: a.scores.said_trust_tier, feedbackCount: a.scores.attestations } : null,
      erc8004: on8004 ? { assetId: a.erc8004.assetId, name: a.erc8004.name, skills: a.erc8004.skills || [], services: a.erc8004.services || [] } : null,
    };
  });

  res.json({
    total, page, limit, totalPages,
    sort: sortBy,
    filters: { source: source || 'all', search: search || null, tier: tier || null, minScore: minScore || null, recommendation: recommendation || null },
    agents: result,
  });
});

// --- Leaderboards ---

app.get('/leaderboard', (req, res) => {
  const metric = req.query.metric || 'agent_fairscore'; // agent_fairscore, reliability, track_record, economic_stake, ecosystem, verification, social
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 5), 100);

  const allAgents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered || a.erc8004 || REGISTRY.saidAgents.has(a.wallet));

  const getValue = {
    agent_fairscore: a => a.scores.agent_fairscore,
    reliability: a => a.features?.reliability || 0,
    track_record: a => a.features?.track_record || 0,
    economic_stake: a => a.features?.economic_stake || 0,
    ecosystem: a => a.features?.ecosystem || 0,
    verification: a => a.features?.verification || 0,
    social: a => a.features?.social || 0,
    fairscore_base: a => a.scores?.fairscore_base || 0,
  }[metric] || (a => a.scores.agent_fairscore);

  const sorted = allAgents
    .sort((a, b) => getValue(b) - getValue(a))
    .slice(0, limit)
    .map((a, i) => ({
      rank: i + 1,
      wallet: a.wallet,
      name: a.erc8004?.name || a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      value: getValue(a),
      agent_fairscore: a.scores.agent_fairscore,
      recommendation: a.recommendation,
      sources: [
        ...(REGISTRY.saidAgents.has(a.wallet) ? ['said'] : []),
        ...(a.erc8004 ? ['erc8004'] : []),
        ...(a.isRegistered ? ['fairscale'] : []),
      ],
    }));

  res.json({ metric, total: allAgents.length, showing: sorted.length, leaderboard: sorted });
});

// --- 8004 Routes ---

app.get('/8004/agents', (req, res) => {
  const agents = Array.from(REGISTRY.erc8004Agents.values());
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  res.json({ source: 'solana-agent-registry-8004', total: agents.length, limit, offset, lastSync: REGISTRY.lastErc8004Sync, agents: agents.slice(offset, offset + limit).map(a => ({ assetId: a.assetId, wallet: a.wallet, name: a.name, description: a.description, image: a.image, services: a.services, skills: a.skills, source: a.source, fetchedAt: a.fetchedAt })) });
});

app.get('/8004/agent/:assetId', async (req, res) => {
  const cached = REGISTRY.erc8004Agents.get(req.params.assetId);
  if (!cached) return res.status(404).json({ error: 'Agent not found in 8004 registry' });
  let fairscaleScore = null;
  if (cached.wallet) {
    const agent = await getOrCreateAgent(cached.wallet);
    if (agent) fairscaleScore = { agent_fairscore: agent.scores.agent_fairscore, fairscore_base: agent.scores.fairscore_base, features: agent.features, descriptions: agent.descriptions };
  }
  res.json({ source: 'solana-agent-registry-8004', agent: { assetId: cached.assetId, wallet: cached.wallet, name: cached.name, description: cached.description, image: cached.image, services: cached.services, skills: cached.skills, rawMetadata: cached.rawMetadata }, fairscale: fairscaleScore });
});

// --- Admin ---

app.post('/admin/sync-8004', async (req, res) => {
  if (req.body.apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  syncFrom8004();
  res.json({ success: true, message: '8004 sync started', currentCount: REGISTRY.erc8004Agents.size, lastSync: REGISTRY.lastErc8004Sync });
});

app.post('/admin/sync-said', async (req, res) => {
  if (req.body.apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  try {
    const agents = await fetchSAIDAgentsOnChain(2000);
    if (agents.length === 0) return res.json({ source: 'SAID (on-chain)', total_found: 0, note: 'No PDAs found.' });
    const results = { success: [], failed: [] };
    for (const agent of agents) {
      if (!agent.wallet) { results.failed.push({ pda: agent.pda, reason: 'No wallet' }); continue; }
      REGISTRY.saidAgents.set(agent.wallet, { pda: agent.pda, layout: agent.layout, syncedAt: new Date().toISOString() });
      try {
        const imported = await getOrCreateAgent(agent.wallet);
        if (imported) results.success.push({ wallet: agent.wallet, pda: agent.pda, score: imported.scores.agent_fairscore });
        else results.failed.push({ wallet: agent.wallet, reason: 'No data' });
      } catch (e) { results.failed.push({ wallet: agent.wallet, reason: e.message }); }
    }
    res.json({ source: 'SAID (on-chain)', total_found: agents.length, imported: results.success.length, failed: results.failed.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/bulk-import', async (req, res) => {
  if (req.body.apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const { wallets } = req.body;
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) return res.status(400).json({ error: 'wallets must be a non-empty array' });
  const results = { success: [], failed: [] };
  for (const wallet of wallets) {
    try { const agent = await getOrCreateAgent(wallet); if (agent) results.success.push({ wallet, score: agent.scores.agent_fairscore }); else results.failed.push({ wallet, reason: 'No data' }); }
    catch (e) { results.failed.push({ wallet, reason: e.message }); }
  }
  res.json({ imported: results.success.length, failed: results.failed.length, results });
});

// --- Stats ---

app.get('/stats', (req, res) => {
  // Count overlaps
  let onBoth = 0;
  for (const [wallet] of REGISTRY.saidAgents) {
    if (REGISTRY.erc8004ByWallet.has(wallet)) onBoth++;
  }
  res.json({
    agents: REGISTRY.agents.size, registered: REGISTRY.registeredAgents.size,
    verified: REGISTRY.verifiedWallets.size, services: REGISTRY.services.size,
    erc8004Agents: REGISTRY.erc8004Agents.size, saidAgents: REGISTRY.saidAgents.size,
    onBothProtocols: onBoth,
    lastErc8004Sync: REGISTRY.lastErc8004Sync, lastSaidSync: REGISTRY.lastSaidSync,
    verificationProviders: { clawkey: 'active', said_onchain: CONFIG.HELIUS_API_KEY ? 'active' : 'no_key', erc8004: CONFIG.HELIUS_API_KEY ? 'active' : 'no_key' },
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Registry v13.1 on port ${CONFIG.PORT}`);
  console.log(`  Integrations: FairScale API, SAID Protocol (on-chain PDA), ERC-8004, ClawKey (VeryAI)`);
  setTimeout(syncFromSAID, 5000);
  setTimeout(syncFrom8004, 15000);
  setInterval(syncFromSAID, 24 * 60 * 60 * 1000);
  setInterval(syncFrom8004, 6 * 60 * 60 * 1000);
});
