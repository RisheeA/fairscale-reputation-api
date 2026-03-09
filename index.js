import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  SATI_PROGRAM: 'satiRkxEiwZ51cv8PRu8UMzuaqeaNU9jABo6oAFMsLe',
  SAS_PROGRAM: 'attsHUrSzCyJqwjddBnTRFStKnPBHPbFTNsm8j22aVr',
  CLAWKEY_API: 'https://clawkey.ai/api',
  KAMIYO_API: 'https://api.kamiyo.ai/api/fusion/fairscale',
  KAMIYO_READ_TOKEN: process.env.KAMIYO_READ_TOKEN || '',
  SCORE_HISTORY_MAX: 10,  // Keep last N snapshots per wallet
  BETA_CODES: {
    ...(process.env.BETA_CODE_ADMIN ? { [process.env.BETA_CODE_ADMIN]: { type: 'unlimited', maxUses: Infinity } } : {}),
    ...(process.env.BETA_CODE_INVITE ? { [process.env.BETA_CODE_INVITE]: { type: 'limited', maxUses: 20 } } : {}),
  },
  ADMIN_KEY: process.env.ADMIN_KEY,
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const BETA = {
  users: new Map(),       // email -> { code, accessedAt, lastLogin, loginCount }
  codeUses: new Map(),    // code -> count
};

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),
  services: new Map(),
  verifiedWallets: new Map(),
  erc8004Agents: new Map(),
  erc8004ByWallet: new Map(),
  saidAgents: new Map(),
  satiAgents: new Map(),        // SATI Token-2022 NFT agents
  satiByWallet: new Map(),      // wallet → SATI agent data
  attestationGraph: new Map(),  // wallet → { attesters: [{wallet, score, timestamp}], weighted_score }
  scoreHistory: new Map(),      // wallet → [{score, timestamp, breakdown}]
  kamiyoData: new Map(),        // wallet → { events: [], reliability: {}, lastFetch }
  lastErc8004Sync: null,
  lastSaidSync: null,
  lastSatiSync: null,
};

// =============================================================================
// PERSISTENCE — Save/load state to disk
// =============================================================================
// Survives Railway restarts and most redeploys. For guaranteed persistence,
// attach a Railway volume at /data and set DATA_DIR=/data in env vars.

const DATA_DIR = process.env.DATA_DIR || '/tmp/fairscale-data';
const STATE_FILE = `${DATA_DIR}/registry-state.json`;
const SAVE_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes

function ensureDataDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.warn('[Persist] Cannot create data dir:', e.message); }
}

function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map) obj[k] = v;
  return obj;
}

function objToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
  }
  return map;
}

function saveState() {
  try {
    ensureDataDir();
    const state = {
      version: 15,
      savedAt: new Date().toISOString(),
      agents: mapToObj(REGISTRY.agents),
      registeredAgents: mapToObj(REGISTRY.registeredAgents),
      services: mapToObj(REGISTRY.services),
      verifiedWallets: mapToObj(REGISTRY.verifiedWallets),
      scoreHistory: mapToObj(REGISTRY.scoreHistory),
      attestationGraph: mapToObj(REGISTRY.attestationGraph),
      merchants: {
        applications: mapToObj(MERCHANTS.applications),
        verified: mapToObj(MERCHANTS.verified),
      },
      beta: {
        users: mapToObj(BETA.users),
        codeUses: mapToObj(BETA.codeUses),
      },
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
    const agentCount = REGISTRY.agents.size;
    const merchantCount = MERCHANTS.verified.size;
    console.log(`[Persist] Saved: ${agentCount} agents, ${merchantCount} merchants, ${BETA.users.size} beta users`);
  } catch (e) {
    console.error('[Persist] Save failed:', e.message);
  }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) { console.log('[Persist] No saved state found — starting fresh'); return false; }
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (!state.version) { console.log('[Persist] Invalid state file — skipping'); return false; }

    // Restore agents (with deduplication — keep highest score per wallet)
    const agentData = state.agents || {};
    for (const [wallet, agent] of Object.entries(agentData)) {
      const existing = REGISTRY.agents.get(wallet);
      if (!existing || (agent.scores?.agent_fairscore || 0) >= (existing.scores?.agent_fairscore || 0)) {
        REGISTRY.agents.set(wallet, agent);
      }
    }

    // Restore other maps
    REGISTRY.registeredAgents = objToMap(state.registeredAgents);
    REGISTRY.services = objToMap(state.services);
    REGISTRY.verifiedWallets = objToMap(state.verifiedWallets);
    REGISTRY.scoreHistory = objToMap(state.scoreHistory);
    REGISTRY.attestationGraph = objToMap(state.attestationGraph);

    // Restore merchants
    if (state.merchants) {
      for (const [k, v] of Object.entries(state.merchants.applications || {})) MERCHANTS.applications.set(k, v);
      for (const [k, v] of Object.entries(state.merchants.verified || {})) MERCHANTS.verified.set(k, v);
    }

    // Restore beta users
    if (state.beta) {
      for (const [k, v] of Object.entries(state.beta.users || {})) BETA.users.set(k, v);
      for (const [k, v] of Object.entries(state.beta.codeUses || {})) BETA.codeUses.set(k, v);
    }

    console.log(`[Persist] Restored: ${REGISTRY.agents.size} agents, ${MERCHANTS.verified.size} merchants, ${BETA.users.size} beta users (saved ${state.savedAt})`);
    return true;
  } catch (e) {
    console.error('[Persist] Load failed:', e.message);
    return false;
  }
}

// Deduplication: ensure no wallet appears twice in the agents map
// (shouldn't happen since Map keys are unique, but sync timing could cause stale entries)
function deduplicateAgents() {
  const walletScores = new Map();
  for (const [wallet, agent] of REGISTRY.agents) {
    const existing = walletScores.get(wallet);
    if (!existing || (agent.scores?.agent_fairscore || 0) > (existing.scores?.agent_fairscore || 0)) {
      walletScores.set(wallet, agent);
    }
  }
  if (walletScores.size !== REGISTRY.agents.size) {
    console.log(`[Dedup] Removed ${REGISTRY.agents.size - walletScores.size} duplicate agents`);
    REGISTRY.agents = walletScores;
  }
}

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

async function getFairScaleScore(wallet, socialHandle = null) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let url = `${CONFIG.FAIRSCALE_API}/score?wallet=${encodeURIComponent(wallet)}`;
      if (socialHandle) url += `&twitter=${encodeURIComponent(socialHandle.replace('@', ''))}`;
      const response = await fetch(url,
        { headers: { accept: 'application/json', fairkey: CONFIG.FAIRSCALE_API_KEY }, signal: AbortSignal.timeout(10000) }
      );
      if (response.status === 429) {
        // Rate limited — exponential backoff
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return null;
      }
      if (!response.ok) {
        if (REGISTRY.agents.size < 5) console.warn(`[FairScale] HTTP ${response.status} for ${wallet.slice(0,8)}`);
        return null;
      }
      return await response.json();
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
        continue;
      }
      console.error('FairScale error:', e.message);
      return null;
    }
  }
  return null;
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
        await new Promise(resolve => setTimeout(resolve, 600));
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
      await new Promise(resolve => setTimeout(resolve, 600));
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
            let saidVerify = null;
            if (REGISTRY.saidAgents.has(agent.wallet)) {
              try { const r = await fetch(`${CONFIG.SAID_API}/api/verify/${agent.wallet}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2000) }); if (r.ok) saidVerify = await r.json(); } catch(e) {}
            }
            const scored = await getOrCreateAgent(agent.wallet, saidVerify);
            if (scored) { scored.erc8004 = tag; imported++; }
            else { failed++; }
          } else { existing.erc8004 = tag; imported++; }
        } else { nullWallets++; }
        await new Promise(resolve => setTimeout(resolve, 600));
      } catch (e) { failed++; console.error(`[8004 Sync] Error scoring agent:`, e.message); }
    }
    console.log(`[8004 Sync] Done: ${imported} scored, ${enriched} metadata, ${nullWallets} null wallets, ${failed} failed / ${rawAgents.length}`);
    REGISTRY.lastErc8004Sync = new Date().toISOString();
    deduplicateAgents();
    saveState();
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

    // Phase 2: Score each wallet. Quick SAID verify call for name/description (2s timeout, ok to fail)
    for (const [wallet] of REGISTRY.saidAgents) {
      try {
        let saidVerify = null;
        try {
          const r = await fetch(`${CONFIG.SAID_API}/api/verify/${wallet}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2000) });
          if (r.ok) saidVerify = await r.json();
        } catch(e) { /* timeout ok, continue without name */ }
        const result = await getOrCreateAgent(wallet, saidVerify);
        if (result) imported++;
        else { skippedNull++; failed++; }
      } catch (e) { failed++; console.error(`[SAID Sync] Score failed for ${wallet.slice(0,8)}:`, e.message); }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    console.log(`[SAID Sync] Scoring: ${imported} imported, ${skippedNull} null responses, ${failed - skippedNull} errors`);

    console.log(`[SAID Sync] Complete: ${imported} imported, ${failed} failed, ${REGISTRY.saidAgents.size} total`);
    console.log(`[Registry] Total agents in memory: ${REGISTRY.agents.size} | SAID: ${REGISTRY.saidAgents.size} | 8004: ${REGISTRY.erc8004Agents.size}`);
    REGISTRY.lastSaidSync = new Date().toISOString();
    deduplicateAgents();
    saveState();
  } catch (e) { console.error('[SAID Sync] Error:', e.message); }
}

// =============================================================================
// SATI (SOLANA AGENT TRUST INFRASTRUCTURE) SYNC
// =============================================================================
// SATI agents are Token-2022 NFTs minted by the SATI program.
// We query Helius DAS API for all assets from the SATI token group.

async function syncFromSATI() {
  console.log('[SATI Sync] Starting (via sati.cascade.fyi REST API)...');
  try {
    const SATI_API = 'https://sati.cascade.fyi';
    let imported = 0, failed = 0, offset = 0;
    const limit = 50;
    let totalAgents = 0;

    // Paginate through all SATI agents with reputation included
    while (true) {
      try {
        const r = await fetch(`${SATI_API}/api/agents?network=mainnet&limit=${limit}&offset=${offset}&includeReputation=true`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) { console.error(`[SATI Sync] HTTP ${r.status} from SATI API`); break; }
        const data = await r.json();
        const agents = data.agents || [];
        totalAgents = data.totalAgents || totalAgents;

        if (agents.length === 0) break;

        for (const agent of agents) {
          try {
            const wallet = agent.owner;
            if (!wallet) { failed++; continue; }

            const satiAgent = {
              assetId: agent.mint,
              wallet,
              name: agent.name || null,
              description: agent.description || null,
              image: agent.image || null,
              services: (agent.services || []).map(s => ({
                name: s.name || 'unknown',
                endpoint: s.endpoint || '',
                ...(s.mcpTools ? { mcpTools: s.mcpTools } : {}),
                ...(s.a2aSkills ? { a2aSkills: s.a2aSkills } : {}),
              })),
              skills: [],
              active: agent.active || false,
              x402Support: agent.x402Support || false,
              supportedTrust: agent.supportedTrust || [],
              memberNumber: agent.memberNumber || null,
              nonTransferable: agent.nonTransferable || false,
              uri: agent.uri || null,
              // Reputation data from SATI
              reputation: agent.reputation ? {
                count: agent.reputation.count || 0,
                summaryValue: agent.reputation.summaryValue || 0,
                summaryValueDecimals: agent.reputation.summaryValueDecimals || 0,
              } : null,
            };

            REGISTRY.satiAgents.set(agent.mint, satiAgent);
            REGISTRY.satiByWallet.set(wallet, satiAgent);
            imported++;
          } catch (e) { failed++; }
        }

        console.log(`[SATI Sync] Page ${Math.floor(offset / limit) + 1}: ${agents.length} agents (${imported} total imported)`);
        offset += limit;
        if (agents.length < limit) break;
        await new Promise(r => setTimeout(r, 300)); // Respect rate limits
      } catch (e) {
        console.error(`[SATI Sync] Page error:`, e.message);
        break;
      }
    }

    console.log(`[SATI Sync] Done: ${imported} agents imported, ${failed} failed, ${totalAgents} total on SATI`);

    // Phase 2: Score SATI agents so they appear in the directory
    let satiScored = 0, satiScoreFailed = 0;
    for (const [mint, agent] of REGISTRY.satiAgents) {
      if (REGISTRY.agents.has(agent.wallet)) {
        // Already scored from SAID/8004 — just make sure sati flag is visible
        satiScored++;
        continue;
      }
      try {
        const result = await getOrCreateAgent(agent.wallet, null);
        if (result) satiScored++;
        else satiScoreFailed++;
      } catch (e) { satiScoreFailed++; }
      await new Promise(r => setTimeout(r, 600));
    }
    console.log(`[SATI Sync] Scoring: ${satiScored} scored, ${satiScoreFailed} failed`);

    // Phase 3: Fetch feedback for ALL SATI agents (don't filter by reputation count — REST API may have data not in summary)
    let feedbackCount = 0, feedbackChecked = 0;
    for (const [mint, agent] of REGISTRY.satiAgents) {
      feedbackChecked++;
      try {
        const fr = await fetch(`${SATI_API}/api/feedback/${mint}?network=mainnet&limit=50`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!fr.ok) continue;
        const fdata = await fr.json();
        const feedbacks = fdata.feedbacks || [];

        if (feedbacks.length > 0) {
          const attesters = feedbacks.map(fb => ({
            wallet: fb.clientAddress || 'sati_reviewer',
            score: fb.value != null ? Math.min(fb.value, 100) : null, // Cap at 100, null if unknown
            timestamp: fb.createdAt ? new Date(fb.createdAt * 1000).toISOString() : null,
            type: 'sati_feedback',
            tag: fb.tag1 || null,
            outcome: fb.outcome,
            message: fb.message || null,
            _dedup_key: fb.clientAddress ? `sati_${fb.clientAddress}_${mint}` : `sati_anon_${fb.createdAt}_${mint}`,
          }));

          // DEDUP: merge with existing but never duplicate by _dedup_key
          const existing = REGISTRY.attestationGraph.get(agent.wallet);
          const existingKeys = new Set((existing?.attesters || []).map(a => a._dedup_key).filter(Boolean));
          const newOnly = attesters.filter(a => !existingKeys.has(a._dedup_key));
          const merged = [...(existing?.attesters || []), ...newOnly];
          // Also dedup by wallet: keep only the latest feedback per reviewer
          const byWallet = new Map();
          for (const a of merged) {
            const key = a.wallet || a._dedup_key;
            const prev = byWallet.get(key);
            if (!prev || (a.timestamp && (!prev.timestamp || a.timestamp > prev.timestamp))) {
              byWallet.set(key, a);
            }
          }
          const deduped = Array.from(byWallet.values());
          const sa = deduped.filter(a => a.score != null);

          REGISTRY.attestationGraph.set(agent.wallet, {
            attesters: deduped,
            attester_count: deduped.length,
            scored_attesters: sa.length,
            weighted_score: sa.length > 0 ? Math.round(sa.reduce((s, a) => s + (a.score * a.score / 100), 0) / sa.reduce((s, a) => s + a.score / 100, 0)) : 0,
            highest_attester: sa.length > 0 ? Math.max(...sa.map(a => a.score)) : 0,
            updated_at: new Date().toISOString(),
          });
          feedbackCount += newOnly.length;
          console.log(`[SATI Feedback] ${agent.name || mint.slice(0,8)}: ${feedbacks.length} feedbacks, ${newOnly.length} new → ${deduped.length} unique attesters`);
        }
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {}
    }

    console.log(`[SATI Sync] Feedback: checked ${feedbackChecked} agents, ${feedbackCount} entries loaded into attestation graph`);

    REGISTRY.lastSatiSync = new Date().toISOString();

    // Build attestation graph for non-SATI agents too
    await buildAttestationGraph();
    deduplicateAgents();
    saveState();
  } catch (e) { console.error('[SATI Sync] Error:', e.message); }
}

// =============================================================================
// ATTESTATION GRAPH
// =============================================================================
// Query SAS attestations for SATI agents to build a weighted trust graph.
// Each attestation = directed edge: attester → agent
// Weight = attester's FairScore (higher score = more trustworthy attestation)

async function buildAttestationGraph() {
  console.log('[Attestation Graph] Building weighted trust graph...');
  if (!CONFIG.HELIUS_API_KEY) return;

  let processed = 0, totalAttestations = 0;

  // Phase 1: SAID reputation is already reflected in verification + social pillars.
  // We do NOT create fake attesters from feedbackCount — that inflates scores and is gameable.
  // Only real, on-chain attestations with verifiable attester wallets count here.
  for (const [wallet] of REGISTRY.saidAgents) {
    processed++;
  }

  // Phase 2: Scan for SATI/SAS on-chain attestations (supplements SAID data)
  const satiWallets = Array.from(REGISTRY.satiByWallet.keys());
  for (const wallet of satiWallets) {
    try {
      const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'attest', method: 'getSignaturesForAddress',
          params: [wallet, { limit: 50 }] })
      });
      const sigs = (await r.json())?.result || [];

      const attesters = [];
      for (const sig of sigs.slice(0, 20)) {
        try {
          const txR = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'tx', method: 'getTransaction',
              params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] })
          });
          const tx = (await txR.json())?.result;
          if (!tx?.transaction?.message) continue;

          const keys = tx.transaction.message.accountKeys || [];
          const programs = keys.map(k => typeof k === 'string' ? k : k.pubkey);
          const isSATI = programs.includes(CONFIG.SATI_PROGRAM);
          const isSAS = programs.includes(CONFIG.SAS_PROGRAM);

          if (isSATI || isSAS) {
            const attesterWallet = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey;
            if (attesterWallet && attesterWallet !== wallet) {
              const attesterAgent = REGISTRY.agents.get(attesterWallet);
              const attesterScore = attesterAgent?.scores?.agent_fairscore || null;
              attesters.push({
                wallet: attesterWallet, score: attesterScore,
                timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                type: isSATI ? 'sati_feedback' : 'sas_attestation', signature: sig.signature,
              });
              totalAttestations++;
            }
          }
        } catch (e) {}
      }

      if (attesters.length > 0) {
        const existing = REGISTRY.attestationGraph.get(wallet);
        // DEDUP: merge but never duplicate by signature
        const existingSigs = new Set((existing?.attesters || []).filter(a => a.signature).map(a => a.signature));
        const newOnly = attesters.filter(a => !existingSigs.has(a.signature));
        const merged = [...(existing?.attesters || []), ...newOnly];
        // Further dedup: one attestation per attester wallet (keep latest)
        const byWallet = new Map();
        for (const a of merged) {
          const key = a.wallet;
          const prev = byWallet.get(key);
          if (!prev || (a.timestamp && (!prev.timestamp || a.timestamp > prev.timestamp))) {
            byWallet.set(key, a);
          }
        }
        const deduped = Array.from(byWallet.values());
        const scored = deduped.filter(a => a.score != null && a.score > 0);
        // STRICT: Only scored attesters contribute to weighted score — no phantom points for unknowns
        const weightedSum = scored.reduce((s, a) => s + (a.score * a.score / 100), 0);
        const totalWeight = scored.reduce((s, a) => s + a.score / 100, 0);
        const weightedScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

        REGISTRY.attestationGraph.set(wallet, {
          attesters: deduped, attester_count: deduped.length, scored_attesters: scored.length,
          weighted_score: weightedScore, highest_attester: scored.length > 0 ? Math.max(...scored.map(a => a.score)) : 0,
          updated_at: new Date().toISOString(),
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {}
  }

  console.log(`[Attestation Graph] Done: ${processed} SAID wallets processed, ${satiWallets.length} SATI wallets scanned, ${totalAttestations} attestations found, ${REGISTRY.attestationGraph.size} with attestation data`);
}

// =============================================================================
// TRANSACTION COUNTERPARTY ANALYSIS
// =============================================================================
// Scan recent transactions to identify which protocols an agent interacts with

const KNOWN_PROGRAMS = {
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter v4',
  'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu': 'Jupiter DCA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  'CAMMCzo5YL8w4VFF8KVHo7nYXQJsqYyPy6Me2ePPjVKi': 'Raydium CLMM',
  'MARBLEaEkHytC8P4koeRjW2BiqJ2WByerv6SMNLeqNq': 'Marinade',
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD': 'Marinade',
  'KLend2g3cP87ber41GjQGELLPS9REVHEUF9AT6kWp7u': 'Kamino',
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1': 'Orca',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpools',
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA': 'Marginfi',
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH': 'Drift',
  'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfSsggi': 'Tensor',
  'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K': 'Magic Eden',
  'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN': 'Tensor Swap',
  'So11111111111111111111111111111111111111112': 'SOL (System)',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token',
  'ComputeBudget111111111111111111111111111111': 'Compute Budget',
  'PhoeijTjjmEiAfm7VbHpfG2E4pNi1Bm3mz6gXo3CRj': 'Phoenix DEX',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'Serum/OpenBook',
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQMoYS': 'OpenBook v2',
  'FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X': 'FluxBeam',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UG': 'Meteora DLMM',
  'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ': 'Saber',
  'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy': 'Stake Pool',
  'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi': 'Staking (BlazeStake)',
  'jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR': 'Jito',
  'JitoSOLzSBP3b4bpPagqjH6nXjaz6QECxJB7hZEYgaN': 'Jito Staking',
};

// Filter out system/infra programs that aren't meaningful counterparties
const SYSTEM_PROGRAMS = new Set([
  'So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
]);

async function scanCounterparties(wallet) {
  if (!CONFIG.HELIUS_API_KEY) return null;
  try {
    const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cp', method: 'getSignaturesForAddress',
        params: [wallet, { limit: 50 }] }),
      signal: AbortSignal.timeout(8000),
    });
    const sigs = (await r.json())?.result || [];
    if (sigs.length === 0) return { protocols: [], raw_programs: [], tx_count: 0 };

    const programCounts = {};
    for (const sig of sigs) {
      try {
        const txR = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'tx', method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
          signal: AbortSignal.timeout(5000),
        });
        const tx = (await txR.json())?.result;
        if (!tx?.transaction?.message) continue;
        const keys = tx.transaction.message.accountKeys || [];
        for (const k of keys) {
          const pubkey = typeof k === 'string' ? k : k.pubkey;
          if (pubkey && !SYSTEM_PROGRAMS.has(pubkey)) {
            programCounts[pubkey] = (programCounts[pubkey] || 0) + 1;
          }
        }
      } catch (e) {}
    }

    // Map to known protocols
    const protocols = [];
    const unknown = [];
    for (const [prog, count] of Object.entries(programCounts).sort((a, b) => b[1] - a[1])) {
      const name = KNOWN_PROGRAMS[prog];
      if (name && !name.includes('Token Program') && !name.includes('System') && !name.includes('Compute')) {
        if (!protocols.find(p => p.name === name)) protocols.push({ name, program: prog, interactions: count });
      } else if (count >= 2) {
        unknown.push({ program: prog.slice(0, 8) + '...', interactions: count });
      }
    }

    return { protocols: protocols.slice(0, 10), unknown_programs: unknown.slice(0, 5), tx_scanned: sigs.length };
  } catch (e) { return null; }
}

// =============================================================================
// FUNDING WALLET ANALYSIS
// =============================================================================
// Discover the wallet that originally funded this agent and score it.
// A high-trust funder = positive signal. A flagged/low-trust funder = red flag.

const KNOWN_EXCHANGES = new Map([
  ['5tzFkiKscjHK98c1KS2VPkCz3MuKG1YB1RJMhZrPMiR2', 'Coinbase'],
  ['2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', 'Binance'],
  ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase Commerce'],
  ['3yFwqXBfZY12a9p2bLqjzz3AVW5AuLTkQM5qXjnxLXYE', 'FTX (defunct)'],
  ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', 'Kraken'],
  ['4xDsmeTWPNjcG5pR3CHTAeRXKwi1XnUF87kv5qXquird', 'OKX'],
]);

async function discoverFundingWallet(wallet) {
  if (!CONFIG.HELIUS_API_KEY) return null;
  try {
    // Get the earliest transaction for this wallet
    const r = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'fund', method: 'getSignaturesForAddress',
        params: [wallet, { limit: 1 }] }), // oldest transaction
      signal: AbortSignal.timeout(8000),
    });
    const sigs = (await r.json())?.result || [];
    if (sigs.length === 0) return null;

    // Get the transaction to find who sent SOL
    const txR = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ftx', method: 'getTransaction',
        params: [sigs[0].signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
      signal: AbortSignal.timeout(8000),
    });
    const tx = (await txR.json())?.result;
    if (!tx?.transaction?.message) return null;

    const keys = tx.transaction.message.accountKeys || [];
    // The signer (first key) who isn't our wallet is likely the funder
    let funderWallet = null;
    for (const k of keys) {
      const pubkey = typeof k === 'string' ? k : k.pubkey;
      const isSigner = typeof k === 'object' ? k.signer : false;
      if (pubkey && pubkey !== wallet && isSigner) {
        funderWallet = pubkey;
        break;
      }
    }
    // Fallback: first key that isn't this wallet
    if (!funderWallet) {
      for (const k of keys) {
        const pubkey = typeof k === 'string' ? k : k.pubkey;
        if (pubkey && pubkey !== wallet && pubkey !== '11111111111111111111111111111111') {
          funderWallet = pubkey;
          break;
        }
      }
    }
    if (!funderWallet) return null;

    // Check if it's a known exchange
    const exchangeName = KNOWN_EXCHANGES.get(funderWallet);

    // Score the funder wallet via FairScale
    let funderScore = null;
    try {
      const fsR = await getFairScaleScore(funderWallet);
      if (fsR?.fairscore_base != null) {
        funderScore = Math.round(fsR.fairscore_base * 1.25); // normalize same as agent base
      }
    } catch (e) {}

    // Also check if funder is a scored agent in our registry
    const funderAgent = REGISTRY.agents.get(funderWallet);
    const funderAgentScore = funderAgent?.scores?.agent_fairscore || null;

    // Determine relationship quality
    let relationship = 'unknown';
    const bestScore = funderAgentScore || funderScore;
    if (exchangeName) relationship = 'exchange';
    else if (bestScore >= 70) relationship = 'high_trust';
    else if (bestScore >= 40) relationship = 'moderate_trust';
    else if (bestScore != null && bestScore < 25) relationship = 'low_trust';
    else if (bestScore != null) relationship = 'neutral';

    return {
      wallet: funderWallet,
      fairscore: funderScore,
      agent_fairscore: funderAgentScore,
      exchange: exchangeName || null,
      relationship,
      first_tx: sigs[0].blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null,
      signature: sigs[0].signature,
    };
  } catch (e) { return null; }
}

// =============================================================================
// KAMIYO INTEGRATION
// =============================================================================
// Kamiyo provides job quality scores, refund rates, and reliability metrics
// for agents that have completed work through their platform.

async function getKamiyoReliability(wallet, timeout = 8000) {
  try {
    const r = await fetch(`${CONFIG.KAMIYO_API}/reliability/${wallet}?window_days=90&service_limit=10`, {
      headers: { 'Authorization': `Bearer ${CONFIG.KAMIYO_READ_TOKEN}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    const data = await r.json();
    // Log first response to understand shape
    if (!getKamiyoReliability._logged) {
      console.log(`[Kamiyo Debug] Reliability response keys: ${JSON.stringify(Object.keys(data))}`);
      console.log(`[Kamiyo Debug] Full response: ${JSON.stringify(data).slice(0, 500)}`);
      getKamiyoReliability._logged = true;
    }
    return data;
  } catch (e) { return null; }
}

async function getKamiyoEvents(wallet, sinceMs = 0) {
  try {
    const r = await fetch(`${CONFIG.KAMIYO_API}/events?wallet=${wallet}&since_ms=${sinceMs}&limit=100`, {
      headers: { 'Authorization': `Bearer ${CONFIG.KAMIYO_READ_TOKEN}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!getKamiyoEvents._logged && data) {
      const sample = Array.isArray(data) ? data[0] : data?.events?.[0];
      console.log(`[Kamiyo Debug] Events response type: ${Array.isArray(data) ? 'array' : typeof data}, keys: ${JSON.stringify(Object.keys(data))}`);
      if (sample) console.log(`[Kamiyo Debug] Event sample keys: ${JSON.stringify(Object.keys(sample))}`);
      console.log(`[Kamiyo Debug] Events sample: ${JSON.stringify(data).slice(0, 500)}`);
      getKamiyoEvents._logged = true;
    }
    return data;
  } catch (e) { return null; }
}

// Fetch and cache Kamiyo data for a wallet
// lightweight=true: only fetch reliability endpoint (for batch sync)
async function fetchKamiyoData(wallet, lightweight = false) {
  const cached = REGISTRY.kamiyoData.get(wallet);
  if (cached && Date.now() - cached.lastFetch < 1800000) return cached; // 30min cache

  // In lightweight mode, only fetch reliability (1 call instead of 2)
  const reliability = await getKamiyoReliability(wallet);
  let events = [];
  
  if (!lightweight && reliability) {
    const eventsData = await getKamiyoEvents(wallet);
    events = Array.isArray(eventsData) ? eventsData : eventsData?.events || [];
  }

  if (!reliability || !reliability.ok) {
    if (events.length === 0) return null;
  }

  // Build metrics from events if available, or from reliability endpoint
  const qualityScores = events.filter(e => e.qualityScore != null).map(e => e.qualityScore);
  const refundPcts = events.filter(e => e.refundPct != null).map(e => e.refundPct);

  const data = {
    events: events.slice(0, 50),
    reliability: reliability || {},
    metrics: {
      total_jobs: events.length || reliability?.sampleSize || 0,
      avg_quality: qualityScores.length > 0 ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length * 10) / 10 : (reliability?.avgQualityScore || null),
      avg_refund: refundPcts.length > 0 ? Math.round(refundPcts.reduce((a, b) => a + b, 0) / refundPcts.length * 10) / 10 : (reliability?.avgRefundPct || null),
      max_quality: qualityScores.length > 0 ? Math.max(...qualityScores) : null,
      min_quality: qualityScores.length > 0 ? Math.min(...qualityScores) : null,
      high_quality_jobs: qualityScores.filter(q => q >= 80).length,
      disputed_jobs: refundPcts.filter(r => r > 0).length,
      dispute_rate: reliability?.disputeRate || 0,
      success_rate: reliability?.successRate || 0,
      reliability_score: reliability?.reliabilityScore || 0,
      services: events.length > 0 ? [...new Set(events.map(e => e.serviceId).filter(Boolean))] : (reliability?.services || []),
    },
    lastFetch: Date.now(),
  };

  REGISTRY.kamiyoData.set(wallet, data);
  return data;
}

// Calculate Kamiyo contribution to scoring pillars
function calculateKamiyoBoosts(kamiyoData) {
  if (!kamiyoData || !kamiyoData.metrics) return { reliabilityBoost: 0, trackRecordBoost: 0, redFlagPenalty: 0, attestationBoost: 0, flags: [] };

  const m = kamiyoData.metrics;
  // No boosts for wallets with 0 completed jobs — recognition only
  if (!m.total_jobs || m.total_jobs === 0) return { reliabilityBoost: 0, trackRecordBoost: 0, redFlagPenalty: 0, attestationBoost: 0, flags: [] };

  const flags = [];

  // RELIABILITY BOOST: only from actual quality data (capped modestly)
  let reliabilityBoost = 0;
  const quality = m.avg_quality || 0;
  if (quality >= 90) reliabilityBoost = 8;
  else if (quality >= 80) reliabilityBoost = 5;
  else if (quality >= 60) reliabilityBoost = 3;

  // TRACK RECORD BOOST: job count (modest — these are early days)
  let trackRecordBoost = 0;
  if (m.total_jobs >= 50) trackRecordBoost = 6;
  else if (m.total_jobs >= 20) trackRecordBoost = 4;
  else if (m.total_jobs >= 5) trackRecordBoost = 2;
  else if (m.total_jobs >= 1) trackRecordBoost = 1;

  // RED FLAG: high refund rate
  let redFlagPenalty = 0;
  if (m.avg_refund != null && m.avg_refund > 0) {
    if (m.avg_refund > 50) { redFlagPenalty = -5; flags.push('kamiyo_high_refund'); }
    else if (m.avg_refund > 25) { redFlagPenalty = -3; flags.push('kamiyo_moderate_refund'); }
    else if (m.avg_refund > 10) { redFlagPenalty = -1; flags.push('kamiyo_some_refunds'); }
  }

  // ATTESTATION BOOST: modest — only from real completed jobs
  let attestationBoost = Math.min(m.total_jobs, 5);

  return { reliabilityBoost, trackRecordBoost, redFlagPenalty, attestationBoost, flags };
}

// =============================================================================
// SCORE HISTORY
// =============================================================================
// Track score changes over time for trend analysis

function recordScoreHistory(wallet, score, breakdown) {
  const history = REGISTRY.scoreHistory.get(wallet) || [];
  history.push({
    score,
    timestamp: new Date().toISOString(),
    fs_combined: breakdown?.fs_combined || null,
    verification: breakdown?.verification || null,
    reliability: breakdown?.reliability || null,
  });
  // Keep only last N
  if (history.length > CONFIG.SCORE_HISTORY_MAX) history.shift();
  REGISTRY.scoreHistory.set(wallet, history);
}

function getScoreTrend(wallet) {
  const history = REGISTRY.scoreHistory.get(wallet);
  if (!history || history.length < 2) return { trend: 'new', change: 0, history: history || [] };

  const latest = history[history.length - 1].score;
  const previous = history[history.length - 2].score;
  const oldest = history[0].score;
  const change = latest - previous;
  const totalChange = latest - oldest;

  let trend = 'stable';
  if (change >= 5) trend = 'rising';
  else if (change <= -5) trend = 'falling';
  else if (totalChange >= 10) trend = 'rising';
  else if (totalChange <= -10) trend = 'falling';

  // Detect sudden drops (red flag)
  const suddenDrop = change <= -15;

  return { trend, change, total_change: totalChange, sudden_drop: suddenDrop, snapshots: history.length, history };
}

// =============================================================================
// TASK-SPECIFIC TRUST PROFILES
// =============================================================================
// Different pillar weightings per use case

const TASK_PROFILES = {
  default: { verification: 0.25, reliability: 0.25, social: 0.15, track_record: 0.15, economic_stake: 0.10, ecosystem: 0.10 },
  defi_execution: { verification: 0.25, reliability: 0.30, social: 0.05, track_record: 0.15, economic_stake: 0.20, ecosystem: 0.05 },
  content_creation: { verification: 0.20, reliability: 0.15, social: 0.25, track_record: 0.15, economic_stake: 0.05, ecosystem: 0.20 },
  social_management: { verification: 0.20, reliability: 0.15, social: 0.30, track_record: 0.15, economic_stake: 0.05, ecosystem: 0.15 },
  trading: { verification: 0.20, reliability: 0.35, social: 0.05, track_record: 0.20, economic_stake: 0.15, ecosystem: 0.05 },
  data_analysis: { verification: 0.20, reliability: 0.20, social: 0.10, track_record: 0.20, economic_stake: 0.10, ecosystem: 0.20 },
  high_value: { verification: 0.30, reliability: 0.30, social: 0.05, track_record: 0.15, economic_stake: 0.15, ecosystem: 0.05 },
};

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

// --- DESCRIPTION QUALITY SIGNAL ---
// Agents with detailed, specific descriptions about what they do are more likely legitimate.
// Measures: length, specificity keywords, professional indicators, red-flag language.
function scoreDescriptionQuality(description) {
  if (!description || description.length < 10) return 0;
  let score = 0;
  const d = description.toLowerCase();
  const len = description.length;

  // Length: longer, more detailed descriptions indicate effort
  if (len >= 30) score += 10;
  if (len >= 80) score += 10;
  if (len >= 150) score += 5;

  // Professional/specific keywords indicating real utility
  const proKeywords = ['api', 'analytics', 'trading', 'defi', 'monitor', 'track', 'data', 'automat', 'manage',
    'portfolio', 'alert', 'intelligence', 'market', 'liquidity', 'yield', 'strategy', 'research',
    'content', 'social', 'community', 'governance', 'security', 'audit', 'report', 'index',
    'oracle', 'bridge', 'swap', 'lend', 'borrow', 'stake', 'nft', 'token', 'protocol',
    'payment', 'invoice', 'escrow', 'wallet', 'custody', 'compliance', 'kyc', 'identity',
    'mcp', 'a2a', 'x402', 'solana', 'agent'];
  const matches = proKeywords.filter(k => d.includes(k)).length;
  score += Math.min(matches * 4, 30);

  // Specificity: mentions specific protocols or tools
  const specifics = ['jupiter', 'raydium', 'marinade', 'meteora', 'drift', 'kamino', 'marginfi',
    'tensor', 'magic eden', 'helius', 'birdeye', 'dexscreener', 'polymarket', 'hyperliquid',
    'openai', 'anthropic', 'claude', 'gpt'];
  const specificMatches = specifics.filter(k => d.includes(k)).length;
  score += Math.min(specificMatches * 8, 24);

  // Red-flag language that suggests spam/scam
  const redFlags = ['guaranteed', 'free money', '100x', 'moonshot', 'send sol', 'dm me', 'airdrop claim'];
  const hasRedFlag = redFlags.some(k => d.includes(k));
  if (hasRedFlag) score = Math.max(score - 20, 0);

  return clamp(score, 0, 100);
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

// Boost ecosystem score when counterparty data is available (called async after scan)
function applyCounterpartyBoost(agent) {
  if (!agent?.counterparties?.protocols?.length) return;
  const trustedCount = agent.counterparties.protocols.length;
  // Each known trusted protocol interaction adds to ecosystem quality
  const boost = Math.min(trustedCount * 5, 20);
  const currentEco = agent.features?.ecosystem || 0;
  if (agent.features) agent.features.ecosystem = Math.min(currentEco + boost, 100);
}

// --- VERIFICATION SCORE (30-35% of composite) ---
// This is the DOMINANT trust signal. Protocol registrations prove intent and commitment.
function calculateVerificationScore(wallet, saidData, verifications) {
  let score = 0;

  const onSaid = REGISTRY.saidAgents.has(wallet);
  const on8004 = REGISTRY.erc8004ByWallet.has(wallet);
  const onSati = REGISTRY.satiByWallet.has(wallet);
  const registryCount = (onSaid ? 1 : 0) + (on8004 ? 1 : 0) + (onSati ? 1 : 0);

  // Base: any registry = strong verification signal
  if (registryCount >= 1) score += 40;
  if (registryCount >= 2) score += 25;  // Dual = 65 base
  if (registryCount >= 3) score += 10;  // Triple = 75 base

  // Human verification (ClawKey)
  if (verifications?.clawkey?.verified) score += 20;

  // SAID reputation tier (strong signal — SAID's own trust assessment)
  if (saidData?.reputation?.trustTier === 'high') score += 12;
  else if (saidData?.reputation?.trustTier === 'medium') score += 6;
  else if (saidData?.reputation?.trustTier === 'low' && onSaid) score += 3;

  // SAID reputation score (if available, additional bonus)
  const saidRepScore = saidData?.reputation?.score || 0;
  if (saidRepScore > 0) score += Math.min(Math.round(saidRepScore * 8), 10);

  // SATI reputation (if available, additional bonus — same weight as SAID)
  const satiData = REGISTRY.satiByWallet.get(wallet);
  const satiRepCount = satiData?.reputation?.count || 0;
  const satiRepValue = satiData?.reputation?.summaryValue || 0;
  if (satiRepCount > 0) score += Math.min(Math.round(satiRepValue / 10), 10);
  if (satiRepCount >= 5) score += 3; // 5+ SATI feedback = extra trust signal

  // Kamiyo marketplace data (only scores when agent has completed real jobs)
  const onKamiyo = REGISTRY.kamiyoData.has(wallet);
  const kamiyoMetrics = REGISTRY.kamiyoData.get(wallet)?.metrics;
  if (onKamiyo && kamiyoMetrics?.total_jobs > 0) {
    if (kamiyoMetrics.total_jobs >= 10) score += 5;
    else if (kamiyoMetrics.total_jobs >= 1) score += 2;
  }

  // Payment verification ($5 USDC — skin in the game)
  if (REGISTRY.verifiedWallets.has(wallet)) score += 10;

  // Self-registration
  if (REGISTRY.registeredAgents.has(wallet)) score += 3;

  // Verified merchant — approved and paying merchant on FairScale
  const isMerchant = Array.from(MERCHANTS.verified.values()).some(m => m.wallet === wallet);
  if (isMerchant) score += 7;

  return clamp(score, 0, 100);
}

// --- SOCIAL & REPUTATION SCORE (15% of composite) ---
// Uses FairScale social_score, SAID attestations/reputation, SAID social handles
function calculateSocialScore(fairscaleData, saidData, satiData) {
  const socialRaw = fairscaleData?.social_score || 0;
  const badges = fairscaleData?.badges || [];
  const attestations = saidData?.reputation?.feedbackCount || 0;
  const saidRepScore = saidData?.reputation?.score || 0;

  // SATI reputation data
  const satiRepCount = satiData?.reputation?.count || 0;
  const satiRepValue = satiData?.reputation?.summaryValue || 0;
  const satiScore = satiRepCount > 0 ? clamp(satiRepValue, 0, 100) : 0;

  const identity = saidData?.identity || {};
  const hasSaidSocials = !!(identity.twitter || identity.x || identity.github || identity.telegram ||
    identity.discord || identity.socials || identity.social);
  const saidSocialBonus = hasSaidSocials ? 20 : 0;

  const fsocialScore = clamp(socialRaw, 0, 100);
  const badgeScore = clamp(badges.length * 12, 0, 100);
  const attestScore = clamp((attestations + satiRepCount) * 6, 0, 100); // Combined SAID + SATI attestations
  const saidScore = clamp(saidRepScore, 0, 100);

  // Best case: have SAID + SATI + FairScale social data
  if (satiScore > 0 && (saidRepScore > 0 || hasSaidSocials)) {
    return clamp(
      (fsocialScore * 0.20) + (saidScore * 0.20) + (satiScore * 0.20) +
      (attestScore * 0.20) + (saidSocialBonus * 0.10) + (badgeScore * 0.10),
      0, 100
    );
  }
  if (satiScore > 0) {
    return clamp(
      (fsocialScore * 0.25) + (satiScore * 0.30) + (attestScore * 0.25) + (badgeScore * 0.20),
      0, 100
    );
  }
  if (saidRepScore > 0 || hasSaidSocials) {
    return clamp(
      (fsocialScore * 0.30) + (saidScore * 0.25) + (attestScore * 0.20) +
      (saidSocialBonus * 0.10) + (badgeScore * 0.15),
      0, 100
    );
  }
  if (socialRaw > 0) {
    return clamp(
      (fsocialScore * 0.55) + (attestScore * 0.25) + (badgeScore * 0.20),
      0, 100
    );
  }
  return clamp(
    (attestScore * 0.40) + (badgeScore * 0.60),
    0, 100
  );
}

// Helper: does this agent have REAL social data?
function hasMeaningfulSocialData(fairscaleData, saidData, satiData) {
  if (fairscaleData?.social_score > 0) return true;
  if (saidData?.reputation?.score > 0) return true;
  if (saidData?.reputation?.feedbackCount > 0) return true;
  if (satiData?.reputation?.count > 0) return true;
  const id = saidData?.identity || {};
  if (id.twitter || id.x || id.github || id.telegram || id.discord || id.socials || id.social) return true;
  return false;
}

// --- RED FLAG DETECTION ---
// Returns a penalty from 0 (no flags) to -15 (severe)
function detectRedFlags(fairscaleData) {
  const f = fairscaleData?.features || {};
  let penalty = 0;
  const flags = [];

  const ageDays = f.wallet_age_days || 0;
  const txCount = f.tx_count || 0;
  const diversity = f.platform_diversity || 0;
  const gapHours = f.median_gap_hours || 0;
  const netFlow = f.net_sol_flow_30d || 0;
  const convictionRatio = f.conviction_ratio || 0;
  const burstRatio = f.burst_ratio || 0;

  // New wallet with high volume
  if (ageDays < 7 && txCount > 100) { penalty -= 3; flags.push('new_wallet_high_volume'); }

  // Single protocol bot
  if (diversity <= 1 && txCount > 100) { penalty -= 3; flags.push('single_protocol_bot'); }

  // Spam-speed transactions
  if (gapHours > 0 && gapHours < 0.05) { penalty -= 2; flags.push('rapid_transactions'); }

  // Instant dumps
  if (f.no_instant_dumps === false || f.no_instant_dumps === 0) { penalty -= 2; flags.push('instant_dumps'); }

  // Heavy SOL drain
  if (netFlow < -10) { penalty -= 2; flags.push('heavy_sol_drain'); }

  // Low conviction — sells quickly, doesn't hold
  if (convictionRatio < 0.3 && txCount > 20) { penalty -= 1; flags.push('low_conviction'); }

  // Very high burst ratio — erratic transaction patterns
  if (burstRatio > 0.9 && txCount > 30) { penalty -= 1; flags.push('erratic_activity'); }

  // Very low diversity with meaningful activity
  if (diversity <= 2 && diversity > 0 && txCount > 50) { penalty -= 1; flags.push('low_diversity'); }

  return { penalty: Math.max(penalty, -10), flags };
}

// --- TIME DECAY ---
// Multiplier from 0.75 (stale) to 1.0 (fresh). Based on FairScale API timestamp
// and on-chain activity recency signals.
function calculateTimeDecay(fairscaleData) {
  const timestamp = fairscaleData?.timestamp;
  const activeDays = fairscaleData?.features?.active_days || 0;
  const ageDays = fairscaleData?.features?.wallet_age_days || 1;

  // FairScale rescores all wallets every 24h.
  // Data < 48h old = definitely fresh. Only decay if significantly older.
  let dataFreshness = 1.0;
  if (timestamp) {
    const hoursOld = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
    if (hoursOld > 72) dataFreshness = 0.95;        // > 3 days — slightly stale
    if (hoursOld > 168) dataFreshness = 0.90;        // > 1 week — missed several rescoring cycles
    if (hoursOld > 720) dataFreshness = 0.85;        // > 30 days — significantly stale
  }

  // Activity ratio: with 1-year FairScale pro data, this is much more meaningful
  const activityRatio = ageDays > 0 ? activeDays / ageDays : 0;
  let activityDecay = 1.0;
  if (activityRatio < 0.01) activityDecay = 0.85;      // Almost never active
  else if (activityRatio < 0.03) activityDecay = 0.90;  // Rarely active
  else if (activityRatio < 0.07) activityDecay = 0.95;  // Occasionally active

  return Math.max(Math.min(dataFreshness, activityDecay), 0.75);
}

// --- PERCENTILE RANKING ---
// Computes percentile rank across all scored agents in registry
function computePercentiles(wallet, features, agentFairScore) {
  const allAgents = Array.from(REGISTRY.agents.values());
  if (allAgents.length < 5) return null;

  const metrics = {
    agent_fairscore: agentFairScore,
    verification: features.verification,
    reliability: features.reliability,
    social: features.social,
    track_record: features.track_record,
    economic_stake: features.economic_stake,
    ecosystem: features.ecosystem,
  };

  const percentiles = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value == null) continue;
    let belowCount = 0, total = 0;
    for (const a of allAgents) {
      const cmp = key === 'agent_fairscore' ? a.scores?.agent_fairscore : a.features?.[key];
      if (cmp != null) { total++; if (cmp < value) belowCount++; }
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
      high: 'Multi-protocol verified (SAID + 8004/SATI + ClawKey)',
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

// Generate a one-line trust summary explaining why the agent scored high or low
function generateTrustSummary(score, features, breakdown, verifications, red_flags) {
  const v = verifications || {};
  const registries = [v.said_onchain && 'SAID', v.erc8004 && 'ERC-8004', v.sati && 'SATI'].filter(Boolean);
  const hasClawKey = v.clawkey?.verified;
  const flagCount = (red_flags || []).length;
  const reliability = features?.reliability || 0;
  const verification = features?.verification || 0;
  const trackRecord = features?.track_record || 0;
  const ecosystem = features?.ecosystem || 0;
  const descQuality = breakdown?.desc_quality || 0;

  const strengths = [];
  if (reliability >= 70) strengths.push('strong behavioral consistency');
  if (ecosystem >= 70) strengths.push('active across multiple protocols');
  if (trackRecord >= 60) strengths.push('established track record');
  if (descQuality >= 40) strengths.push('well-documented capabilities');
  if (hasClawKey) strengths.push('human-verified identity');

  const weaknesses = [];
  if (verification < 30 && registries.length === 0) weaknesses.push('no protocol registrations');
  if (reliability < 30) weaknesses.push('limited behavioral data');
  if (trackRecord < 25) weaknesses.push('short history');

  if (score >= 75) {
    const detail = strengths.length ? ` Strengths: ${strengths.slice(0, 3).join(', ')}.` : '';
    if (registries.length >= 2) return `Multi-registry verified agent (${registries.join(' + ')}) with high trust across all pillars.${detail} Suitable for high-value interactions and credit.`;
    return `High-trust agent with excellent on-chain behavior.${detail} Suitable for most agent interactions.`;
  }
  if (score >= 55) {
    const detail = strengths.length ? ` Strengths: ${strengths.slice(0, 2).join(', ')}.` : '';
    const improve = weaknesses.length ? ` Could improve: ${weaknesses[0]}.` : '';
    if (registries.length >= 1) return `Verified on ${registries.join(' + ')} with good trust fundamentals.${detail}${improve}`;
    return `Moderate trust profile with decent on-chain activity.${detail}${improve} Registry verification would boost score significantly.`;
  }
  if (score >= 40) {
    const issue = weaknesses.length ? weaknesses.join(', ') : 'limited overall data';
    return `Basic trust level — ${issue}. ${flagCount > 0 ? `Flagged: ${red_flags.map(f => f.replace(/_/g, ' ')).join(', ')}. ` : ''}Exercise caution. Not recommended for credit.`;
  }
  if (registries.length >= 1) return `Verified on ${registries.join(' + ')} but limited on-chain data available. ${weaknesses.length ? weaknesses.join(', ') + '. ' : ''}Score may improve as more behavioral data becomes available.`;
  return `Limited trust data. ${weaknesses.length ? weaknesses.join(', ') + '. ' : ''}${flagCount > 0 ? `${flagCount} flag${flagCount > 1 ? 's' : ''} detected. ` : ''}Additional verification and on-chain history would strengthen this profile.`;
}

// =============================================================================
// AGENT FAIRSCORE COMPOSITE
// =============================================================================

function calculateAgentFairScore(fairscaleData, features, saidData, wallet, verifications = {}, taskProfile = null, descQuality = 0, satiData = null) {
  // CRITICAL: Use fairscore_base (wallet-only, max ~80 without social) and normalize to 0-100.
  // FairScale's combined `fairscore` includes social_score (20/100 of total).
  // If we use combined as our base AND have a separate social pillar, we double-penalize missing social.
  // Solution: use fairscore_base and normalize: a wallet scoring 64/80 on-chain = 80/100 in our system.
  const fsBase = fairscaleData?.fairscore_base || 0;
  const fsSocial = fairscaleData?.social_score || 0;
  const hasFSSocial = fsSocial > 0;

  // Normalize base score: FairScale base is out of ~80 without social
  const fsBaseNormalized = hasFSSocial
    ? fsBase
    : Math.min(Math.round(fsBase * 1.25), 100);

  const verificationScore = calculateVerificationScore(wallet, saidData, verifications);
  const socialScore = calculateSocialScore(fairscaleData, saidData, satiData);
  const hasSocialData = hasMeaningfulSocialData(fairscaleData, saidData, satiData);

  // Select weight profile: task-specific or default with dynamic redistribution
  let weights;
  if (taskProfile && TASK_PROFILES[taskProfile]) {
    weights = { ...TASK_PROFILES[taskProfile] };
    // Still redistribute social weight if no data
    if (!hasSocialData && weights.social > 0) {
      const socialW = weights.social;
      weights.social = 0;
      weights.verification += socialW * 0.4;
      weights.reliability += socialW * 0.4;
      weights.track_record += socialW * 0.2;
    }
  } else if (hasSocialData) {
    weights = { verification: 0.35, reliability: 0.22, social: 0.12, track_record: 0.13, economic_stake: 0.08, ecosystem: 0.10 };
  } else {
    weights = { verification: 0.40, reliability: 0.25, social: 0, track_record: 0.16, economic_stake: 0.09, ecosystem: 0.10 };
  }

  const trustComposite = (
    (verificationScore * weights.verification) +
    (features.reliability * weights.reliability) +
    (socialScore * weights.social) +
    (features.track_record * weights.track_record) +
    (features.economic_stake * weights.economic_stake) +
    (features.ecosystem * weights.ecosystem)
  );

  // Attestation graph boost (up to +12 points)
  // CONSERVATIVE: Only real, deduplicated attestations from SCORED attesters count.
  // Unscored/anonymous attestations get zero boost — you must be a known entity to vouch.
  // Count-based boosts are logarithmic to prevent gaming via volume.
  const graphData = REGISTRY.attestationGraph.get(wallet);
  let attestationBoost = 0;
  if (graphData) {
    // Only count UNIQUE, SCORED attesters (deduplicated by wallet)
    const uniqueScored = new Map();
    for (const a of (graphData.attesters || [])) {
      if (a.score != null && a.score > 0 && a.wallet && !a.wallet.startsWith('said_feedback')) {
        // Keep highest score per unique attester wallet
        const existing = uniqueScored.get(a.wallet);
        if (!existing || a.score > existing.score) uniqueScored.set(a.wallet, a);
      }
    }
    const uniqueCount = uniqueScored.size;
    const scoredAttesters = Array.from(uniqueScored.values());

    if (uniqueCount > 0) {
      // Logarithmic count boost: 1=2pts, 3=4pts, 5=5pts, 10=7pts — hard to game with volume
      const countBoost = Math.min(Math.round(Math.log2(uniqueCount + 1) * 2.5), 7);
      // Quality: average attester score matters — only high-score attesters move the needle
      const avgAttesterScore = scoredAttesters.reduce((s, a) => s + a.score, 0) / uniqueCount;
      const qualityBoost = avgAttesterScore >= 60 ? 3 : avgAttesterScore >= 40 ? 1 : 0;
      // High-trust attester: only if they score 70+ (genuinely trusted)
      const highestAttester = Math.max(...scoredAttesters.map(a => a.score));
      const highTrustBoost = highestAttester >= 70 ? 2 : 0;

      attestationBoost = Math.min(countBoost + qualityBoost + highTrustBoost, 12);
    }
  }

  // Description quality boost (up to +5 points)
  // Agents with detailed, specific descriptions about their utility are more credible
  const descBoost = Math.min(Math.round(descQuality * 0.05), 5);

  // Multi-registry bonus: agents verified on 2+ protocols get a direct score boost
  // This is THE strongest trust signal — separate from the pillar weighting
  const onSaid = REGISTRY.saidAgents.has(wallet);
  const on8004 = REGISTRY.erc8004ByWallet.has(wallet);
  const onSati = REGISTRY.satiByWallet.has(wallet);
  const registryCount = (onSaid ? 1 : 0) + (on8004 ? 1 : 0) + (onSati ? 1 : 0);
  let multiRegistryBonus = 0;
  if (registryCount >= 3) multiRegistryBonus = 8;
  else if (registryCount >= 2) multiRegistryBonus = 5;

  // Blend: 20% FairScale base, 80% trust composite + bonuses
  // Trust composite is where verification, reliability, etc. live — it should dominate
  // Kamiyo integration: job quality, track record, and refund flags
  const kamiyoData = REGISTRY.kamiyoData.get(wallet);
  const kamiyoBoosts = calculateKamiyoBoosts(kamiyoData);

  let blended = (fsBaseNormalized * 0.20) + (trustComposite * 0.80) + attestationBoost + descBoost + multiRegistryBonus;

  const { penalty, flags } = detectRedFlags(fairscaleData);
  blended += penalty;
  blended += kamiyoBoosts.redFlagPenalty;
  flags.push(...kamiyoBoosts.flags);

  // Score trend penalty: sudden drops are suspicious
  const trend = getScoreTrend(wallet);
  if (trend.sudden_drop) {
    blended -= 5;
    flags.push('sudden_score_drop');
  }

  const decay = calculateTimeDecay(fairscaleData);
  blended *= decay;

  const score = Math.max(Math.min(Math.round(blended), 100), 5);

  // Record score history
  const breakdown = {
    fs_base_raw: Math.round(fsBase),
    fs_base_normalized: Math.round(fsBaseNormalized),
    fs_social_raw: Math.round(fsSocial),
    blend: { base_weight: 0.20, composite_weight: 0.80 },
    trust_composite: Math.round(trustComposite),
    verification: Math.round(verificationScore),
    social: Math.round(socialScore),
    has_social_data: hasSocialData,
    weights_used: weights,
    task_profile: taskProfile || 'default',
    reliability: features.reliability,
    track_record: features.track_record,
    economic_stake: features.economic_stake,
    ecosystem: features.ecosystem,
    attestation_boost: attestationBoost,
    attestation_data: graphData ? { count: graphData.attester_count, weighted_score: graphData.weighted_score, highest: graphData.highest_attester } : null,
    desc_quality: descQuality,
    desc_boost: descBoost,
    kamiyo: kamiyoData ? {
      reliability_boost: kamiyoBoosts.reliabilityBoost,
      track_record_boost: kamiyoBoosts.trackRecordBoost,
      attestation_boost: kamiyoBoosts.attestationBoost,
      red_flag_penalty: kamiyoBoosts.redFlagPenalty,
      metrics: kamiyoData.metrics,
    } : null,
    multi_registry_bonus: multiRegistryBonus,
    red_flag_penalty: penalty,
    red_flags: flags,
    time_decay: decay,
    score_trend: trend.trend,
    score_change: trend.change,
  };
  recordScoreHistory(wallet, score, breakdown);

  return { score, breakdown };
}

function getRecommendationTier(score, verifications, wallet) {
  const isHumanVerified = verifications?.clawkey?.verified || false;
  const on8004 = REGISTRY.erc8004ByWallet.has(wallet);
  const onSaid = REGISTRY.saidAgents.has(wallet);
  const onSati = REGISTRY.satiByWallet.has(wallet);
  const registryCount = (on8004 ? 1 : 0) + (onSaid ? 1 : 0) + (onSati ? 1 : 0);

  if (score >= 70 && isHumanVerified) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };
  if (score >= 65 && registryCount >= 2) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };
  if (score >= 75 && registryCount >= 1) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };
  if (score >= 60 && registryCount >= 3) return { tier: 'highly_recommended', label: 'Highly Recommended', color: 'gold' };

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

async function getOrCreateAgent(wallet, prefetchedSaidData = undefined) {
  if (REGISTRY.agents.has(wallet)) {
    const cached = REGISTRY.agents.get(wallet);
    if (Date.now() - new Date(cached.lastUpdated).getTime() < 1800000) return cached;
  }

  const regData = REGISTRY.registeredAgents.get(wallet);
  const satiData = REGISTRY.satiByWallet.get(wallet);
  const knownHandle = regData?.twitter || satiData?.twitter || null;

  // If SAID data was pre-fetched (e.g. during sync), skip redundant API call
  let fairscaleData, saidData;
  if (prefetchedSaidData !== undefined) {
    saidData = prefetchedSaidData;
    fairscaleData = await getFairScaleScore(wallet, knownHandle || saidData?.identity?.twitter || saidData?.identity?.x || null);
  } else {
    const [fsResult, saidResult] = await Promise.all([
      getFairScaleScore(wallet, knownHandle),
      getSAIDData(wallet)
    ]);
    fairscaleData = fsResult;
    saidData = saidResult;
  }

  // If SAID provided a handle and FairScale didn't get social, re-try with handle
  const saidHandle = saidData?.identity?.twitter || saidData?.identity?.x || null;
  if (saidHandle && !knownHandle && fairscaleData?.social_score === 0) {
    const enriched = await getFairScaleScore(wallet, saidHandle);
    if (enriched) fairscaleData = enriched;
  }
  const socialHandle = saidHandle || knownHandle;

  if (!fairscaleData && !saidData) {
    console.warn(`[Score] No data for ${wallet.slice(0,8)}... (both APIs returned null)`);
    return null;
  }

  // Debug: log response shapes for first 3 agents to understand available fields
  if (REGISTRY.agents.size < 3) {
    if (fairscaleData) console.log(`[Debug FairScale] Keys: ${Object.keys(fairscaleData).join(', ')}${fairscaleData.badges ? ` | badges[0]: ${JSON.stringify(fairscaleData.badges[0])}` : ''}${fairscaleData.actions ? ` | actions[0]: ${JSON.stringify(fairscaleData.actions?.[0])}` : ''}${fairscaleData.social_score != null ? ` | social_score: ${fairscaleData.social_score}` : ''}`);
    if (saidData) console.log(`[Debug SAID] Keys: ${Object.keys(saidData).join(', ')}${saidData.identity ? ` | identity keys: ${Object.keys(saidData.identity).join(', ')}` : ''}`);
  }

  // ClawKey verification
  const verifications = {};
  try {
    const deviceId = regData?.clawkeyDeviceId || null;
    if (deviceId) verifications.clawkey = await getClawKeyVerification(deviceId);
  } catch (e) { console.error('[Verifications]', e.message); }

  const features = calculateAgentFeatures(fairscaleData);
  
  // Resolve 8004 metadata early (needed for description + name)
  const erc8004Data = REGISTRY.erc8004ByWallet.get(wallet);
  const erc8004Tag = erc8004Data ? { assetId: erc8004Data.assetId, name: erc8004Data.name, services: erc8004Data.services || [], skills: erc8004Data.skills || [] } : null;

  // Resolve description for quality scoring
  const agentDescription = regData?.description || erc8004Data?.description || satiData?.description || saidData?.identity?.description || null;
  const descQuality = scoreDescriptionQuality(agentDescription);
  
  const scoreResult = calculateAgentFairScore(fairscaleData, features, saidData, wallet, verifications, null, descQuality, satiData);
  const agentFairScore = scoreResult.score;
  const breakdown = scoreResult.breakdown;
  const recommendation = getRecommendationTier(agentFairScore, verifications, wallet);
  const percentiles = computePercentiles(wallet, features, agentFairScore);

  const agent = {
    wallet,
    name: regData?.name || erc8004Data?.name || satiData?.name || saidData?.identity?.name || null,
    description: regData?.description || erc8004Data?.description || satiData?.description || saidData?.identity?.description || null,
    website: regData?.website || saidData?.identity?.website || null,
    mcp: regData?.mcp || saidData?.endpoints?.mcp || null,
    scores: {
      agent_fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore_base || fairscaleData?.fairscore || 0),
      social_score: Math.round(fairscaleData?.social_score || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: (saidData?.reputation?.feedbackCount || 0) + (satiData?.reputation?.count || 0),
      sati_reputation: satiData?.reputation ? {
        count: satiData.reputation.count,
        value: satiData.reputation.summaryValue,
      } : null,
    },
    breakdown,
    percentiles,
    recommendation,
    features: {
      ...features,
      // Apply Kamiyo boosts to pillars
      reliability: Math.min((features.reliability || 0) + (breakdown.kamiyo?.reliability_boost || 0), 100),
      track_record: Math.min((features.track_record || 0) + (breakdown.kamiyo?.track_record_boost || 0), 100),
      verification: breakdown.verification,
      social: breakdown.social,
      desc_quality: descQuality,
    },
    verifications: {
      clawkey: verifications.clawkey ? { verified: verifications.clawkey.verified, humanId: verifications.clawkey.humanId } : null,
      said_onchain: REGISTRY.saidAgents.has(wallet),
      erc8004: REGISTRY.erc8004ByWallet.has(wallet),
      sati: REGISTRY.satiByWallet.has(wallet),
      kamiyo: REGISTRY.kamiyoData.has(wallet),
      merchant_verified: Array.from(MERCHANTS.verified.values()).some(m => m.wallet === wallet),
    },
    erc8004: erc8004Tag,
    sati: REGISTRY.satiByWallet.has(wallet) ? {
      assetId: REGISTRY.satiByWallet.get(wallet).assetId,
      name: REGISTRY.satiByWallet.get(wallet).name,
      services: REGISTRY.satiByWallet.get(wallet).services || [],
      skills: REGISTRY.satiByWallet.get(wallet).skills || [],
    } : null,
    kamiyo: REGISTRY.kamiyoData.has(wallet) ? {
      metrics: REGISTRY.kamiyoData.get(wallet).metrics,
      reliability: REGISTRY.kamiyoData.get(wallet).reliability,
    } : null,
    attestation_graph: REGISTRY.attestationGraph.get(wallet) || null,
    score_trend: getScoreTrend(wallet),
    badges: fairscaleData?.badges || [],
    actions: fairscaleData?.actions || [],
    red_flags: breakdown.red_flags,
    socials: {
      twitter: saidData?.identity?.twitter || saidData?.identity?.x || null,
      github: saidData?.identity?.github || null,
      telegram: saidData?.identity?.telegram || null,
      discord: saidData?.identity?.discord || null,
      website: saidData?.identity?.website || regData?.website || null,
    },
    descriptions: {
      reliability: getFeatureDescription('reliability', features.reliability),
      track_record: getFeatureDescription('track_record', features.track_record),
      economic_stake: getFeatureDescription('economic_stake', features.economic_stake),
      ecosystem: getFeatureDescription('ecosystem', features.ecosystem),
      verification: getFeatureDescription('verification', breakdown.verification),
      social: getFeatureDescription('social', breakdown.social),
    },
    trust_summary: generateTrustSummary(agentFairScore, { ...features, verification: breakdown.verification }, breakdown, {
      said_onchain: REGISTRY.saidAgents.has(wallet),
      erc8004: REGISTRY.erc8004ByWallet.has(wallet),
      sati: REGISTRY.satiByWallet.has(wallet),
      clawkey: verifications.clawkey,
    }, breakdown.red_flags),
    isRegistered: REGISTRY.registeredAgents.has(wallet),
    isSaidAgent: REGISTRY.saidAgents.has(wallet),
    isVerified: REGISTRY.verifiedWallets.has(wallet),
    services: Array.from(REGISTRY.services.values()).filter(s => s.wallet === wallet),
    counterparties: null,
    funder: null,
    lastUpdated: new Date().toISOString(),
  };

  // Async: scan counterparties + discover funder in background
  scanCounterparties(wallet).then(cp => {
    if (cp && agent) {
      agent.counterparties = cp;
      applyCounterpartyBoost(agent);
    }
  }).catch(() => {});

  discoverFundingWallet(wallet).then(funder => {
    if (funder && agent) {
      agent.funder = funder;
      // Apply funder score impact to the agent
      if (funder.relationship === 'low_trust') {
        // Low-trust funder: slight negative impact
        agent.scores.agent_fairscore = Math.max(agent.scores.agent_fairscore - 3, 5);
        agent.red_flags = [...(agent.red_flags || []), 'low_trust_funder'];
      } else if (funder.relationship === 'high_trust') {
        // High-trust funder: slight positive
        agent.scores.agent_fairscore = Math.min(agent.scores.agent_fairscore + 2, 100);
      }
    }
  }).catch(() => {});

  REGISTRY.agents.set(wallet, agent);
  return agent;
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '15.0.0',
    description: 'The Trust & Discovery Layer for Solana AI Agents',
    api: {
      v1: {
        'GET /v1/score?wallet=': 'Score any Solana wallet (?task=defi_execution for task-specific scoring)',
        'POST /v1/score/batch': 'Score up to 25 wallets',
        'GET /v1/directory': 'Query agent directory (?page&limit&sort&source&min_score&verified_only&recommendation&has_flags)',
        'GET /v1/trust-gate?wallet=&min_score=40': 'Trust decision: allow/deny (?require_verification&require_no_flags&task=defi_execution)',
        'GET /v1/agent/:wallet_or_name': 'Lookup agent by wallet or name',
        'GET /v1/task-profiles': 'List available task-specific scoring profiles',
        'GET /v1/score-history?wallet=': 'Score trend and history for a wallet',
        'GET /v1/attestation-graph?wallet=': 'Attestation network data for a wallet',
        'GET /v1/health': 'Health check',
      }
    },
    endpoints: {
      'GET /score': 'Get agent score (legacy)', 'POST /register': 'Register agent (optional clawkeyDeviceId)',
      'POST /verify': 'Verify payment', 'POST /service': 'Register x402 service',
      'GET /services': 'List services',
      'GET /directory': 'Agent directory (?page=1&limit=25&source=8004|said|fairscale|both&sort=agent_fairscore|reliability|track_record|economic_stake|ecosystem|verification|social&search=...&recommendation=highly_recommended|recommended|acceptable)',
      'GET /leaderboard': 'Sub-score leaderboards (?metric=agent_fairscore|reliability|track_record|economic_stake|ecosystem|verification|social&limit=25)',
      'GET /stats': 'Registry stats', 'GET /8004/agents': 'List 8004 agents',
    },
    integrations: { erc8004: 'Solana Agent Registry', said: 'SAID Protocol (on-chain PDA)', sati: 'Solana Agent Trust Infrastructure (Token-2022)', sas: 'Solana Attestation Service', clawkey: 'ClawKey / VeryAI', fairscale: 'FairScale Scoring Engine' },
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
      socials: agent.socials,
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

// --- Public Directory API v1 ---
// Allows protocols to query the directory programmatically

app.get('/v1/directory', (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
  const sort = req.query.sort || 'agent_fairscore';
  const source = req.query.source;
  const search = (req.query.search || '').toLowerCase().trim();
  const recommendation = req.query.recommendation;
  const min_score = parseInt(req.query.min_score) || 0;
  const verified_only = req.query.verified_only === 'true';
  const has_flags = req.query.has_flags; // 'true' or 'false'

  let agents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered || a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet) || REGISTRY.saidAgents.has(a.wallet) || REGISTRY.satiByWallet.has(a.wallet));

  if (source === '8004') agents = agents.filter(a => !!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet));
  else if (source === 'said') agents = agents.filter(a => REGISTRY.saidAgents.has(a.wallet));
  else if (source === 'sati') agents = agents.filter(a => REGISTRY.satiByWallet.has(a.wallet));
  else if (source === 'both') agents = agents.filter(a => (!!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet)) && REGISTRY.saidAgents.has(a.wallet));
  else if (source === 'fairscale') agents = agents.filter(a => a.isRegistered);

  if (search) agents = agents.filter(a => a.wallet.toLowerCase().includes(search) || (a.name || '').toLowerCase().includes(search));
  if (min_score > 0) agents = agents.filter(a => a.scores.agent_fairscore >= min_score);
  if (recommendation) agents = agents.filter(a => a.recommendation?.tier === recommendation);
  if (verified_only) agents = agents.filter(a => a.verifications?.clawkey?.verified || a.verifications?.erc8004 || a.verifications?.said_onchain);
  if (has_flags === 'false') agents = agents.filter(a => !a.red_flags?.length);
  else if (has_flags === 'true') agents = agents.filter(a => a.red_flags?.length > 0);

  const sortFns = {
    agent_fairscore: (a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore,
    reliability: (a, b) => (b.features?.reliability || 0) - (a.features?.reliability || 0),
    track_record: (a, b) => (b.features?.track_record || 0) - (a.features?.track_record || 0),
    economic_stake: (a, b) => (b.features?.economic_stake || 0) - (a.features?.economic_stake || 0),
    ecosystem: (a, b) => (b.features?.ecosystem || 0) - (a.features?.ecosystem || 0),
    verification: (a, b) => (b.features?.verification || 0) - (a.features?.verification || 0),
    social: (a, b) => (b.features?.social || 0) - (a.features?.social || 0),
  };
  agents.sort(sortFns[sort] || sortFns.agent_fairscore);

  const total = agents.length;
  const totalPages = Math.ceil(total / limit);
  const paged = agents.slice((page - 1) * limit, page * limit);

  res.json({
    total,
    page,
    limit,
    total_pages: totalPages,
    agents: paged.map((a, i) => ({
      wallet: a.wallet,
      name: a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      description: a.description || null,
      fairscore: a.scores.agent_fairscore,
      tier: a.scores.agent_fairscore >= 70 ? 'gold' : a.scores.agent_fairscore >= 40 ? 'silver' : 'bronze',
      recommendation: a.recommendation,
      features: a.features,
      red_flags: a.red_flags || [],
      verification: {
        said: a.verifications?.said_onchain || false,
        erc8004: a.verifications?.erc8004 || false,
        clawkey: a.verifications?.clawkey?.verified || false,
        payment: a.isVerified || false,
        registered: a.isRegistered || false,
      },
      sources: [
        ...(REGISTRY.saidAgents.has(a.wallet) ? ['said'] : []),
        ...(a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet) ? ['erc8004'] : []),
        ...(REGISTRY.satiByWallet.has(a.wallet) ? ['sati'] : []),
        ...(a.isRegistered ? ['fairscale'] : []),
      ],
      socials: a.socials || {},
      scored_at: a.lastUpdated,
    })),
    meta: { provider: 'FairScale', version: 'v1', generated_at: new Date().toISOString() },
  });
});

// --- Trust Gate API ---
// Single-call decision endpoint for protocols: "should I trust this agent for this action?"
// Returns a simple allow/deny with reasoning

app.get('/v1/trust-gate', async (req, res) => {
  const { wallet, min_score, require_verification, require_no_flags, task } = req.query;
  if (!wallet) return res.status(400).json({ error: 'missing_wallet', message: 'Provide ?wallet=<solana_address>' });

  const minScore = parseInt(min_score) || 40;
  const requireVerification = require_verification !== 'false'; // default true
  const requireNoFlags = require_no_flags === 'true'; // default false
  const taskProfile = task && TASK_PROFILES[task] ? task : null;

  try {
    const agent = await getOrCreateAgent(wallet);
    if (!agent) return res.json({ wallet, decision: 'deny', reason: 'unscored', message: 'Wallet could not be scored — no data available' });

    const score = agent.scores.agent_fairscore;
    const hasVerification = agent.verifications?.said_onchain || agent.verifications?.erc8004 || agent.verifications?.sati || agent.verifications?.clawkey?.verified;
    const hasFlags = (agent.red_flags || []).length > 0;
    const reasons = [];

    let decision = 'allow';

    if (score < minScore) { decision = 'deny'; reasons.push(`score_below_threshold: ${score} < ${minScore}`); }
    if (requireVerification && !hasVerification) { decision = 'deny'; reasons.push('no_verification: not registered on SAID, 8004, SATI, or ClawKey'); }
    if (requireNoFlags && hasFlags) { decision = 'deny'; reasons.push(`red_flags_detected: ${agent.red_flags.join(', ')}`); }

    res.json({
      wallet,
      decision,
      fairscore: score,
      tier: score >= 70 ? 'gold' : score >= 40 ? 'silver' : 'bronze',
      recommendation: agent.recommendation?.tier || 'unverified',
      reasons: reasons.length ? reasons : ['passed_all_checks'],
      verification: {
        said: agent.verifications?.said_onchain || false,
        erc8004: agent.verifications?.erc8004 || false,
        sati: agent.verifications?.sati || false,
        clawkey: agent.verifications?.clawkey?.verified || false,
      },
      red_flags: agent.red_flags || [],
      score_trend: agent.score_trend || null,
      attestation_graph: (() => { const ag = REGISTRY.attestationGraph.get(agent.wallet) || agent.attestation_graph; return ag ? { attester_count: ag.attester_count, weighted_score: ag.weighted_score } : null; })(),
      meta: { provider: 'FairScale', version: 'v1', scored_at: agent.lastUpdated, cache_ttl: 1800, gate_config: { min_score: minScore, require_verification: requireVerification, require_no_flags: requireNoFlags, task: taskProfile || 'default' } },
    });
  } catch (e) {
    console.error('trust-gate error:', e.message);
    res.status(500).json({ error: 'internal_error', decision: 'deny', reason: 'scoring_failed' });
  }
});

// --- Agent Lookup by Name ---
app.get('/v1/agent/:identifier', async (req, res) => {
  const id = req.params.identifier;
  // Try as wallet first
  if (id.length >= 32 && id.length <= 44) {
    try {
      const agent = await getOrCreateAgent(id);
      if (agent) {
        const s = agent.scores.agent_fairscore;
        return res.json({
          wallet: agent.wallet, name: agent.name, description: agent.description,
          fairscore: s, tier: s >= 70 ? 'gold' : s >= 40 ? 'silver' : 'bronze',
          recommendation: agent.recommendation, features: agent.features,
          breakdown: agent.breakdown, percentiles: agent.percentiles,
          red_flags: agent.red_flags, badges: agent.badges, socials: agent.socials,
          verification: {
            said: agent.verifications?.said_onchain || false,
            erc8004: agent.verifications?.erc8004 || false,
            clawkey: agent.verifications?.clawkey?.verified || false,
          },
          erc8004: agent.erc8004, scored_at: agent.lastUpdated,
          meta: { provider: 'FairScale', version: 'v1' },
        });
      }
    } catch (e) {}
  }
  // Try as name search
  const search = id.toLowerCase();
  const matches = Array.from(REGISTRY.agents.values())
    .filter(a => (a.name || '').toLowerCase().includes(search))
    .sort((a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore)
    .slice(0, 10);
  if (matches.length) {
    return res.json({
      results: matches.map(a => ({
        wallet: a.wallet, name: a.name, fairscore: a.scores.agent_fairscore,
        recommendation: a.recommendation?.tier,
        sources: [
          ...(REGISTRY.saidAgents.has(a.wallet) ? ['said'] : []),
          ...(a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet) ? ['erc8004'] : []),
        ...(REGISTRY.satiByWallet.has(a.wallet) ? ['sati'] : []),
        ],
      })),
      meta: { provider: 'FairScale', version: 'v1', query: id },
    });
  }
  res.status(404).json({ error: 'not_found', message: `No agent found for "${id}"` });
});

// --- Legacy score endpoint ---

app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  const agent = await getOrCreateAgent(wallet);
  if (!agent) return res.status(404).json({ error: 'Could not fetch data', wallet });
  // Fetch Kamiyo data on-demand (cached 30min, only when profile is viewed)
  try { await fetchKamiyoData(wallet); } catch (e) {}
  const liveKamiyo = REGISTRY.kamiyoData.get(wallet);

  res.json({ wallet, name: agent.name || `Agent ${wallet.slice(0, 8)}...`, description: agent.description, website: agent.website, mcp: agent.mcp, agent_fairscore: agent.scores.agent_fairscore, fairscore_base: agent.scores.fairscore_base, social_score: agent.scores.social_score, trust_summary: agent.trust_summary, recommendation: agent.recommendation, features: agent.features, breakdown: agent.breakdown, percentiles: agent.percentiles, badges: agent.badges, red_flags: agent.red_flags, socials: agent.socials, attestation_graph: REGISTRY.attestationGraph.get(wallet) || agent.attestation_graph || null, score_trend: agent.score_trend, counterparties: agent.counterparties, funder: agent.funder, kamiyo: liveKamiyo ? { metrics: liveKamiyo.metrics, reliability: liveKamiyo.reliability } : agent.kamiyo, descriptions: agent.descriptions, said: { score: agent.scores.said_score, trustTier: agent.scores.said_trust_tier, feedbackCount: agent.scores.attestations }, verifications: { ...agent.verifications, kamiyo: !!liveKamiyo }, isRegistered: agent.isRegistered, isSaidAgent: agent.isSaidAgent, isVerified: agent.isVerified, services: agent.services, scores: agent.scores });
});

// --- Registration ---

app.post('/register', async (req, res) => {
  const { wallet, name, description, website, mcp, twitter, clawkeyDeviceId } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

  let clawkeyResult = null;
  if (clawkeyDeviceId) {
    clawkeyResult = await getClawKeyVerification(clawkeyDeviceId);
    console.log(`[Register] ClawKey for ${wallet}: ${clawkeyResult?.verified ? 'VERIFIED' : 'not verified'}`);
  }

  REGISTRY.registeredAgents.set(wallet, { wallet, name, description, website, mcp, twitter: twitter || null, clawkeyDeviceId: clawkeyDeviceId || null, clawkeyVerified: clawkeyResult?.verified || false, registeredAt: new Date().toISOString() });
  REGISTRY.agents.delete(wallet);
  const agent = await getOrCreateAgent(wallet);
  res.json({ success: true, message: 'Agent registered' + (twitter ? ` (social: ${twitter})` : ''), clawkey: clawkeyResult ? { verified: clawkeyResult.verified, humanId: clawkeyResult.humanId } : null, agent: agent ? { wallet, name: agent.name, agent_fairscore: agent.scores.agent_fairscore, social_score: agent.scores.social_score } : null });
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
    .filter(a => a.isRegistered || a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet) || REGISTRY.saidAgents.has(a.wallet) || REGISTRY.satiByWallet.has(a.wallet));

  // Source filter
  if (source === '8004') agents = agents.filter(a => !!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet));
  else if (source === 'said') agents = agents.filter(a => REGISTRY.saidAgents.has(a.wallet));
  else if (source === 'sati') agents = agents.filter(a => REGISTRY.satiByWallet.has(a.wallet));
  else if (source === 'kamiyo') agents = agents.filter(a => REGISTRY.kamiyoData.has(a.wallet));
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

  // Attestation filter — show only agents with attestation data
  if (req.query.has_attestations === '1') {
    agents = agents.filter(a => {
      const ag = REGISTRY.attestationGraph.get(a.wallet) || a.attestation_graph;
      return ag && ag.attester_count > 0;
    });
  }

  // Flagged filter — show only agents with red flags
  if (req.query.has_flags === '1') {
    agents = agents.filter(a => a.red_flags && a.red_flags.length > 0);
  }

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

  // Compute global rankings (once, outside the map)
  const allSorted = Array.from(REGISTRY.agents.values())
    .filter(ag => ag.scores?.agent_fairscore > 0)
    .sort((x, y) => y.scores.agent_fairscore - x.scores.agent_fairscore);
  const globalRankMap = new Map();
  allSorted.forEach((ag, idx) => globalRankMap.set(ag.wallet, idx + 1));

  const result = paged.map((a, i) => {
    const onSaid = REGISTRY.saidAgents.has(a.wallet);
    const on8004 = !!a.erc8004 || REGISTRY.erc8004ByWallet.has(a.wallet);
    const onSati = REGISTRY.satiByWallet.has(a.wallet);
    const onKamiyo = REGISTRY.kamiyoData.has(a.wallet);
    const sources = [];
    if (onSaid) sources.push('said');
    if (on8004) sources.push('erc8004');
    if (onSati) sources.push('sati');
    if (onKamiyo) sources.push('kamiyo');
    if (a.isRegistered) sources.push('fairscale');

    const boosts = {};
    if (onSaid) boosts.said_onchain = '+3';
    if (on8004) boosts.erc8004_registry = '+5';
    if (onSati) boosts.sati_registry = '+5';
    if (onKamiyo) boosts.kamiyo_performance = '+' + (REGISTRY.kamiyoData.get(a.wallet)?.metrics?.total_jobs > 0 ? '5-20' : '0');
    if (onSaid && on8004) boosts.dual_registry = '+3';
    if (a.isRegistered) boosts.fairscale_registered = '+2';
    if (a.isVerified) boosts.payment_verified = '+5';
    if (a.verifications?.clawkey?.verified) boosts.clawkey_human = '+10';
    if (a.scores?.said_score > 0) boosts.said_reputation = `+${Math.min((a.scores.attestations || 0) * 3, 12)}`;
    if (a.scores?.said_trust_tier === 'high') boosts.said_trust = '+4';
    const isMerchantAgent = Array.from(MERCHANTS.verified.values()).some(m => m.wallet === a.wallet);
    if (isMerchantAgent) boosts.verified_merchant = '+7';

    return {
      rank: offset + i + 1,
      global_rank: globalRankMap.get(a.wallet) || null,
      total_ranked: allSorted.length,
      wallet: a.wallet,
      name: a.erc8004?.name || a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      agent_fairscore: a.scores.agent_fairscore,
      fairscore_base: a.scores.fairscore_base,
      recommendation: a.recommendation,
      features: a.features,
      isVerified: a.isVerified,
      humanVerified: a.verifications?.clawkey?.verified || false,
      services: (a.services?.length || 0) + (a.erc8004?.services?.length || 0),
      sources,
      boosts,
      said: onSaid ? { pda: REGISTRY.saidAgents.get(a.wallet)?.pda || null, score: a.scores.said_score, trustTier: a.scores.said_trust_tier, feedbackCount: a.scores.attestations } : null,
      erc8004: on8004 ? { assetId: a.erc8004?.assetId || REGISTRY.erc8004ByWallet.get(a.wallet)?.assetId || null, name: a.erc8004?.name || REGISTRY.erc8004ByWallet.get(a.wallet)?.name || null, skills: a.erc8004?.skills || [], services: a.erc8004?.services || [] } : null,
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
        ...(REGISTRY.satiByWallet.has(a.wallet) ? ['sati'] : []),
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
  let onBoth = 0, onTriple = 0;
  for (const [wallet] of REGISTRY.saidAgents) {
    if (REGISTRY.erc8004ByWallet.has(wallet) || REGISTRY.satiByWallet.has(wallet)) onBoth++;
    if (REGISTRY.erc8004ByWallet.has(wallet) && REGISTRY.satiByWallet.has(wallet)) onTriple++;
  }
  res.json({
    agents: REGISTRY.agents.size, registered: REGISTRY.registeredAgents.size,
    verified: REGISTRY.verifiedWallets.size, services: REGISTRY.services.size,
    erc8004Agents: REGISTRY.erc8004Agents.size, saidAgents: REGISTRY.saidAgents.size,
    satiAgents: REGISTRY.satiAgents.size,
    kamiyoAgents: REGISTRY.kamiyoData.size,
    attestationGraphSize: REGISTRY.attestationGraph.size,
    scoreHistorySize: REGISTRY.scoreHistory.size,
    onBothProtocols: onBoth, onTripleProtocols: onTriple,
    lastErc8004Sync: REGISTRY.lastErc8004Sync, lastSaidSync: REGISTRY.lastSaidSync, lastSatiSync: REGISTRY.lastSatiSync,
    verificationProviders: { clawkey: 'active', said_onchain: CONFIG.HELIUS_API_KEY ? 'active' : 'no_key', erc8004: CONFIG.HELIUS_API_KEY ? 'active' : 'no_key', sati: 'active' },
    persistence: { data_dir: DATA_DIR, state_file: STATE_FILE, file_exists: existsSync(STATE_FILE) },
    merchants: { applications: MERCHANTS.applications.size, verified: MERCHANTS.verified.size },
    betaUsers: BETA.users.size,
  });
});

// --- Admin: Manual persistence ---
app.post('/admin/save', (req, res) => {
  if (req.body.apiKey !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  saveState();
  res.json({ success: true, message: 'State saved', agents: REGISTRY.agents.size, merchants: MERCHANTS.verified.size });
});

app.post('/admin/dedup', (req, res) => {
  if (req.body.apiKey !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const before = REGISTRY.agents.size;
  deduplicateAgents();
  res.json({ success: true, before, after: REGISTRY.agents.size, removed: before - REGISTRY.agents.size });
});

// --- Task Profiles ---
app.get('/v1/task-profiles', (req, res) => {
  res.json({
    profiles: Object.entries(TASK_PROFILES).map(([name, weights]) => ({
      name, weights,
      description: {
        default: 'Balanced trust assessment across all pillars',
        defi_execution: 'Optimized for DeFi operations — heavy on reliability and economic stake',
        content_creation: 'Optimized for content agents — heavy on social reputation and ecosystem diversity',
        social_management: 'Optimized for social media agents — heaviest on social reputation',
        trading: 'Optimized for trading bots — heaviest on reliability with strong track record',
        data_analysis: 'Optimized for data/analytics agents — balanced reliability and diversity',
        high_value: 'Optimized for high-value operations — maximum verification and reliability',
      }[name] || '',
    })),
    usage: 'Add ?task=defi_execution to /v1/trust-gate or /v1/score to use task-specific weights',
  });
});

// --- Score History ---
app.get('/v1/score-history', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'missing_wallet' });
  const trend = getScoreTrend(wallet);
  res.json({ wallet, ...trend, meta: { provider: 'FairScale', version: 'v1', max_snapshots: CONFIG.SCORE_HISTORY_MAX } });
});

// --- Attestation Graph ---
app.get('/v1/attestation-graph', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'missing_wallet' });
  const data = REGISTRY.attestationGraph.get(wallet);
  if (!data) return res.json({ wallet, attesters: [], attester_count: 0, weighted_score: 0, message: 'No attestation data found' });
  res.json({ wallet, ...data, meta: { provider: 'FairScale', version: 'v1' } });
});

// --- Dashboard / Ecosystem Health ---
app.get('/v1/dashboard', (req, res) => {
  const allAgents = Array.from(REGISTRY.agents.values());
  const scores = allAgents.map(a => a.scores?.agent_fairscore || 0).filter(s => s > 0);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const medianScore = scores.length ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)] : 0;

  // Score distribution buckets
  const distribution = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };
  scores.forEach(s => {
    if (s < 20) distribution['0-19']++;
    else if (s < 40) distribution['20-39']++;
    else if (s < 60) distribution['40-59']++;
    else if (s < 80) distribution['60-79']++;
    else distribution['80-100']++;
  });

  // Verification rates
  const verified = allAgents.filter(a => a.isSaidAgent || a.verifications?.erc8004 || a.verifications?.sati);
  const dualVerified = allAgents.filter(a => {
    let c = 0;
    if (a.isSaidAgent) c++; if (a.verifications?.erc8004) c++; if (a.verifications?.sati) c++;
    return c >= 2;
  });

  // Red flag rate
  const flagged = allAgents.filter(a => (a.red_flags || []).length > 0);

  // Recommendation breakdown
  const tiers = { highly_recommended: 0, recommended: 0, acceptable: 0, caution: 0, unverified: 0 };
  allAgents.forEach(a => { const t = a.recommendation?.tier; if (t && tiers[t] !== undefined) tiers[t]++; });

  // Top protocols by agent usage (from counterparty data)
  const protocolCounts = {};
  allAgents.forEach(a => {
    (a.counterparties?.protocols || []).forEach(p => {
      protocolCounts[p.name] = (protocolCounts[p.name] || 0) + 1;
    });
  });
  const topProtocols = Object.entries(protocolCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, agents]) => ({ name, agents }));

  // Top 10 leaderboard
  const leaderboard = allAgents
    .filter(a => a.scores?.agent_fairscore > 0)
    .sort((a, b) => (b.scores?.agent_fairscore || 0) - (a.scores?.agent_fairscore || 0))
    .slice(0, 10)
    .map((a, i) => ({
      rank: i + 1, wallet: a.wallet, name: a.name, agent_fairscore: a.scores.agent_fairscore,
      recommendation: a.recommendation, socials: a.socials || {}, sources: [
        a.isSaidAgent ? 'said' : null, a.verifications?.erc8004 ? 'erc8004' : null,
        a.verifications?.sati ? 'sati' : null
      ].filter(Boolean),
    }));

  res.json({
    overview: {
      total_agents: allAgents.length,
      total_scored: scores.length,
      average_score: avgScore,
      median_score: medianScore,
      highest_score: scores.length ? Math.max(...scores) : 0,
      said_agents: REGISTRY.saidAgents.size,
      erc8004_agents: REGISTRY.erc8004Agents.size,
      sati_agents: REGISTRY.satiByWallet.size,
    },
    verification: {
      verified_count: verified.length,
      verified_rate: scores.length ? Math.round((verified.length / scores.length) * 100) : 0,
      dual_verified: dualVerified.length,
      dual_rate: scores.length ? Math.round((dualVerified.length / scores.length) * 100) : 0,
    },
    health: {
      flagged_count: flagged.length,
      flag_rate: scores.length ? Math.round((flagged.length / scores.length) * 100) : 0,
      attestation_coverage: REGISTRY.attestationGraph.size,
      kamiyo_agents: REGISTRY.kamiyoData.size,
    },
    score_distribution: distribution,
    recommendation_tiers: tiers,
    top_protocols: topProtocols,
    leaderboard,
  });
});

// =============================================================================
// BETA ACCESS GATE
// =============================================================================

// Validate an access code + register email
app.post('/beta/validate', (req, res) => {
  const { code, email } = req.body;
  if (!code || !email) return res.status(400).json({ error: 'Missing code or email' });
  const emailLower = email.toLowerCase().trim();

  const codeDef = CONFIG.BETA_CODES[code];
  if (!codeDef) return res.status(401).json({ error: 'Invalid access code' });

  // Check usage limit
  const currentUses = BETA.codeUses.get(code) || 0;
  if (codeDef.type === 'limited' && currentUses >= codeDef.maxUses) {
    return res.status(403).json({ error: 'Access code has reached its usage limit' });
  }

  // Register or update user
  const existing = BETA.users.get(emailLower);
  if (existing) {
    existing.lastLogin = new Date().toISOString();
    existing.loginCount = (existing.loginCount || 0) + 1;
  } else {
    BETA.users.set(emailLower, {
      email: emailLower, code, accessedAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(), loginCount: 1,
    });
    // Only increment code usage for NEW users
    if (codeDef.type === 'limited') {
      BETA.codeUses.set(code, currentUses + 1);
    }
  }

  console.log(`[Beta] Access granted: ${emailLower} (code: ${code.slice(0,4)}..., total users: ${BETA.users.size})`);
  res.json({ success: true, email: emailLower });
});

// Login with existing email (no code needed)
app.post('/beta/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const emailLower = email.toLowerCase().trim();

  const user = BETA.users.get(emailLower);
  if (!user) return res.status(401).json({ error: 'No account found. Use an access code first.' });

  user.lastLogin = new Date().toISOString();
  user.loginCount = (user.loginCount || 0) + 1;
  console.log(`[Beta] Login: ${emailLower} (visit #${user.loginCount})`);
  res.json({ success: true, email: emailLower });
});

// Admin: view all beta users (requires admin key)
app.get('/beta/users', (req, res) => {
  const { key } = req.query;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const users = Array.from(BETA.users.values())
    .sort((a, b) => new Date(b.accessedAt) - new Date(a.accessedAt));

  const codeStats = {};
  for (const [code, def] of Object.entries(CONFIG.BETA_CODES)) {
    codeStats[code.slice(0, 4) + '...'] = {
      type: def.type,
      maxUses: def.maxUses === Infinity ? 'unlimited' : def.maxUses,
      currentUses: BETA.codeUses.get(code) || 0,
    };
  }

  res.json({
    total_users: users.length,
    code_stats: codeStats,
    users: users.map(u => ({
      email: u.email,
      code: u.code.slice(0, 4) + '...',
      signed_up: u.accessedAt,
      last_login: u.lastLogin,
      visits: u.loginCount,
    })),
  });
});

// =============================================================================
// MERCHANT VERIFICATION SYSTEM
// =============================================================================
// Merchants apply → Admin reviews → Verified merchants get listed and become
// eligible for agent spend via x402 lending platform.

const MERCHANTS = {
  applications: new Map(),  // id → { ...application, status: 'pending'|'approved'|'rejected' }
  verified: new Map(),      // id → { ...merchant, verifiedAt, banner, profileImage }
};

// Merchant application (public — anyone can apply)
app.post('/merchants/apply', (req, res) => {
  const { business_name, wallet, website, x_handle, contact_email, description, category, services_offered, x402_endpoint } = req.body;
  if (!business_name || !wallet || !contact_email) return res.status(400).json({ error: 'Missing required fields: business_name, wallet, contact_email' });
  if (wallet.length < 32 || wallet.length > 44) return res.status(400).json({ error: 'Invalid Solana wallet address' });

  const id = `merch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const application = {
    id, business_name, wallet, website: website || null, x_handle: x_handle || null,
    contact_email, description: description || null, category: category || 'general',
    services_offered: services_offered || [], x402_endpoint: x402_endpoint || null, status: 'pending',
    applied_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null,
    banner_url: null, profile_image_url: null, notes: null,
  };
  MERCHANTS.applications.set(id, application);
  console.log(`[Merchant] New application: ${business_name} (${wallet.slice(0,8)}...)`);
  res.json({ success: true, id, message: 'Application submitted. We will review and get back to you.' });
});

// Admin: list all applications
app.get('/merchants/admin/applications', (req, res) => {
  const { key, status } = req.query;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  let apps = Array.from(MERCHANTS.applications.values());
  if (status) apps = apps.filter(a => a.status === status);
  apps.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at));
  res.json({ total: apps.length, applications: apps });
});

// Admin: review an application (approve/reject + fill in details)
app.post('/merchants/admin/review', (req, res) => {
  const { key, id, decision, business_name, description, category, website, x_handle,
    banner_url, profile_image_url, services_offered, notes, payment_tier, x402_endpoint } = req.body;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!id || !decision) return res.status(400).json({ error: 'Missing id or decision' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });

  const app = MERCHANTS.applications.get(id);
  if (!app) return res.status(404).json({ error: 'Application not found' });

  app.status = decision;
  app.reviewed_at = new Date().toISOString();
  app.reviewed_by = 'admin';
  if (notes) app.notes = notes;

  if (decision === 'approved') {
    // Admin can override/fill in merchant details
    const merchant = {
      id: app.id, wallet: app.wallet,
      business_name: business_name || app.business_name,
      description: description || app.description,
      category: category || app.category,
      website: website || app.website,
      x_handle: x_handle || app.x_handle,
      contact_email: app.contact_email,
      banner_url: banner_url || app.banner_url || null,
      profile_image_url: profile_image_url || app.profile_image_url || null,
      services_offered: services_offered || app.services_offered || [],
      payment_tier: payment_tier || 'standard',
      x402_endpoint: x402_endpoint || app.x402_endpoint || null,
      verified_at: new Date().toISOString(),
      applied_at: app.applied_at,
      fairscore: null, // Will be populated on first directory load
    };
    MERCHANTS.verified.set(id, merchant);
    // Force re-score their wallet so the +7 merchant boost applies immediately
    REGISTRY.agents.delete(app.wallet);
    getOrCreateAgent(app.wallet).then(agent => {
      if (agent) merchant.fairscore = agent.scores.agent_fairscore;
    }).catch(() => {});
    console.log(`[Merchant] APPROVED: ${merchant.business_name} (${app.wallet.slice(0,8)}...)`);
  } else {
    console.log(`[Merchant] REJECTED: ${app.business_name} (${app.wallet.slice(0,8)}...) — ${notes || 'no reason'}`);
  }
  res.json({ success: true, id, decision, merchant: MERCHANTS.verified.get(id) || null });
});

// Admin: update a verified merchant (images, details)
app.post('/merchants/admin/update', (req, res) => {
  const { key, id, ...updates } = req.body;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const merchant = MERCHANTS.verified.get(id);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
  const allowed = ['business_name', 'description', 'category', 'website', 'x_handle', 'banner_url', 'profile_image_url', 'services_offered', 'payment_tier', 'notes', 'x402_endpoint'];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) merchant[k] = v;
  }
  merchant.updated_at = new Date().toISOString();
  res.json({ success: true, merchant });
});

// Admin: remove a merchant
app.post('/merchants/admin/remove', (req, res) => {
  const { key, id } = req.body;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const deleted = MERCHANTS.verified.delete(id);
  if (deleted) {
    const app = MERCHANTS.applications.get(id);
    if (app) app.status = 'removed';
  }
  res.json({ success: true, deleted });
});

// Admin: directly add a verified merchant (skip application flow)
app.post('/merchants/admin/add', (req, res) => {
  const { key, business_name, wallet, description, category, website, x_handle,
    contact_email, banner_url, profile_image_url, services_offered, payment_tier, x402_endpoint } = req.body;
  if (key !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!business_name || !wallet) return res.status(400).json({ error: 'Missing business_name or wallet' });

  const id = `merch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const merchant = {
    id, wallet, business_name,
    description: description || null, category: category || 'general',
    website: website || null, x_handle: x_handle || null,
    contact_email: contact_email || null,
    banner_url: banner_url || null, profile_image_url: profile_image_url || null,
    services_offered: services_offered || [], payment_tier: payment_tier || 'standard',
    x402_endpoint: x402_endpoint || null,
    verified_at: new Date().toISOString(), applied_at: new Date().toISOString(),
    fairscore: null,
  };
  MERCHANTS.verified.set(id, merchant);
  REGISTRY.agents.delete(wallet); // Force re-score so +7 merchant boost applies
  getOrCreateAgent(wallet).then(agent => {
    if (agent) merchant.fairscore = agent.scores.agent_fairscore;
  }).catch(() => {});
  console.log(`[Merchant] Admin direct add: ${business_name} (${wallet.slice(0,8)}...)`);
  res.json({ success: true, id, merchant });
});

// Public: list verified merchants
app.get('/merchants', (req, res) => {
  const { category } = req.query;
  let merchants = Array.from(MERCHANTS.verified.values());
  if (category) merchants = merchants.filter(m => m.category === category);
  // Pull live scores and names from the agent registry
  merchants.forEach(m => {
    const agent = REGISTRY.agents.get(m.wallet);
    if (agent) {
      m.fairscore = agent.scores.agent_fairscore;
      // Use agent name if merchant doesn't have a custom override
      if (agent.name && !m._name_override) m.display_name = agent.name;
    }
  });
  merchants.sort((a, b) => (b.fairscore || 0) - (a.fairscore || 0));
  res.json({
    total: merchants.length,
    merchants: merchants.map(m => ({
      id: m.id, business_name: m.business_name, wallet: m.wallet,
      description: m.description, category: m.category,
      website: m.website, x_handle: m.x_handle,
      banner_url: m.banner_url, profile_image_url: m.profile_image_url,
      services_offered: m.services_offered, payment_tier: m.payment_tier,
      x402_endpoint: m.x402_endpoint || null,
      fairscore: m.fairscore, verified_at: m.verified_at,
    })),
  });
});

// Public: get single merchant
app.get('/merchants/:id', (req, res) => {
  const merchant = MERCHANTS.verified.get(req.params.id);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
  res.json({ merchant });
});

// =============================================================================
// START
// =============================================================================

// Save state on shutdown — register BEFORE listen so they're active early
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} received — saving state...`);
  try { saveState(); } catch (e) { console.error('[Shutdown] Save failed:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('beforeExit', () => { if (!shuttingDown) { console.log('[beforeExit] Saving state...'); try { saveState(); } catch(e) {} } });

// Load persisted state before starting
loadState();
deduplicateAgents();

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Registry v15.0 on port ${CONFIG.PORT}`);
  console.log(`  Integrations: FairScale API, SAID Protocol, ERC-8004, SATI, SAS, ClawKey, Kamiyo`);
  console.log(`  Features: Attestation Graph (v2 deduped), Score History, Task Profiles, Trust Gate, Merchant Verification, Persistence`);
  console.log(`  Data dir: ${DATA_DIR}`);
  setTimeout(syncFromSAID, 5000);
  setTimeout(syncFrom8004, 15000);
  setTimeout(syncFromSATI, 30000);
  setTimeout(syncKamiyo, 60000);
  setInterval(syncFromSAID, 24 * 60 * 60 * 1000);
  setInterval(syncFrom8004, 6 * 60 * 60 * 1000);
  setInterval(syncFromSATI, 6 * 60 * 60 * 1000);
  setInterval(syncKamiyo, 3 * 60 * 60 * 1000);

  // Periodic save every 5 minutes
  setInterval(saveState, SAVE_INTERVAL);
  // Save after initial sync completes (~2 minutes)
  setTimeout(saveState, 120000);
  // Dedup after syncs complete
  setTimeout(deduplicateAgents, 180000);
});

// Kamiyo batch sync — lightweight check for all scored agents
async function syncKamiyo() {
  console.log('[Kamiyo Sync] Starting...');
  let fetched = 0, withData = 0, errors = 0;
  const wallets = Array.from(REGISTRY.agents.keys());
  for (const wallet of wallets) {
    try {
      // Use 3s timeout for batch — skip quickly if Kamiyo doesn't know this wallet
      const reliability = await getKamiyoReliability(wallet, 3000);
      fetched++;
      if (reliability && reliability.ok) {
        const data = {
          events: [],
          reliability,
          metrics: {
            total_jobs: reliability.sampleSize || 0,
            avg_quality: reliability.avgQualityScore || null,
            avg_refund: reliability.avgRefundPct || null,
            max_quality: null, min_quality: null,
            high_quality_jobs: 0,
            disputed_jobs: 0,
            dispute_rate: reliability.disputeRate || 0,
            success_rate: reliability.successRate || 0,
            reliability_score: reliability.reliabilityScore || 0,
            services: reliability.services || [],
          },
          lastFetch: Date.now(),
        };
        REGISTRY.kamiyoData.set(wallet, data);
        withData++;
      }
    } catch (e) { errors++; }
  }
  console.log(`[Kamiyo Sync] Done: ${fetched}/${wallets.length} checked, ${withData} with data, ${errors} errors`);
}
