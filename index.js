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
  // ERC-8004 / Solana Agent Registry
  ERC8004_REGISTRY_PROGRAM: '8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ',
  ERC8004_ATOM_PROGRAM: 'AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb',
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),
  services: new Map(),
  verifiedWallets: new Map(),
  erc8004Agents: new Map(),  // 8004 registry agents keyed by asset pubkey
  lastErc8004Sync: null,
};

// =============================================================================
// API CLIENTS
// =============================================================================

async function getFairScaleScore(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.FAIRSCALE_API}/score?wallet=${encodeURIComponent(wallet)}`,
      { headers: { 'accept': 'application/json', 'fairkey': CONFIG.FAIRSCALE_API_KEY } }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.error('FairScale error:', e.message);
    return null;
  }
}

async function getSAIDData(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.SAID_API}/api/verify/${encodeURIComponent(wallet)}`,
      { headers: { 'accept': 'application/json' } }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.error('SAID error:', e.message);
    return null;
  }
}

// =============================================================================
// ERC-8004 SOLANA AGENT REGISTRY CLIENT
// =============================================================================
// Queries the on-chain 8004 agent registry via Helius DAS API (Metaplex Core
// NFTs) and resolves IPFS metadata. Zero SDK dependencies — pure fetch.
// =============================================================================

/**
 * Fetch all agent NFTs from the 8004 registry via Helius.
 * Strategy:
 *   1. getProgramAccounts on 8004 registry to find config + agent PDAs
 *   2. Extract collection address from RegistryConfig PDA
 *   3. Use getAssetsByGroup (collection) via DAS API
 *   4. Fallback: getAssetsByCreator with registry program
 */
async function fetch8004Agents(limit = 500) {
  if (!CONFIG.HELIUS_API_KEY) {
    console.warn('[8004 Sync] No HELIUS_API_KEY — skipping on-chain fetch');
    return [];
  }

  // Step 1: Try to find the collection address from the RegistryConfig PDA
  let collectionAddress = null;
  try {
    const configResp = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getProgramAccounts',
        params: [
          CONFIG.ERC8004_REGISTRY_PROGRAM,
          { encoding: 'base64', commitment: 'confirmed',
            filters: [{ dataSize: 97 }] // RegistryConfig: 8 disc + 32 collection + 1 type + 32 authority + 24 padding = ~97
          }
        ]
      })
    });
    const configData = await configResp.json();
    const configAccounts = configData?.result || [];
    console.log(`[8004 Sync] Found ${configAccounts.length} config PDAs`);
    
    if (configAccounts.length > 0) {
      const buf = Buffer.from(configAccounts[0].account.data[0], 'base64');
      // RegistryConfig layout: 8-byte discriminator + 32-byte collection pubkey
      if (buf.length >= 40) {
        collectionAddress = encodeBase58(buf.slice(8, 40));
        console.log(`[8004 Sync] Collection address: ${collectionAddress}`);
      }
    }
  } catch (e) {
    console.warn('[8004 Sync] Config PDA lookup failed:', e.message);
  }

  // Step 2: If we found a collection, query DAS by group
  if (collectionAddress) {
    try {
      const agents = await fetch8004ByCollection(collectionAddress, limit);
      if (agents.length > 0) return agents;
    } catch (e) {
      console.warn('[8004 Sync] Collection-based fetch failed:', e.message);
    }
  }

  // Step 3: Fallback — try getAssetsByCreator with the registry program
  try {
    const agents = await fetch8004ByCreator(limit);
    if (agents.length > 0) return agents;
  } catch (e) {
    console.warn('[8004 Sync] Creator-based fetch failed:', e.message);
  }

  // Step 4: Last resort — getProgramAccounts on 8004 to find agent PDAs directly
  try {
    return await fetch8004FromProgramAccounts(limit);
  } catch (e) {
    console.error('[8004 Sync] All fetch methods failed:', e.message);
    return [];
  }
}

async function fetch8004ByCollection(collectionAddress, limit = 500) {
  const agents = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && agents.length < limit) {
    const response = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAssetsByGroup',
        params: {
          groupKey: 'collection',
          groupValue: collectionAddress,
          page,
          limit: 100,
        }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];
    if (items.length === 0) { hasMore = false; break; }
    for (const item of items) {
      const agent = parse8004Asset(item);
      if (agent) agents.push(agent);
    }
    page++;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[8004 Sync] getAssetsByGroup returned ${agents.length} agents`);
  return agents;
}

async function fetch8004ByCreator(limit = 500) {
  const agents = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && agents.length < limit) {
    const response = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAssetsByCreator',
        params: {
          creatorAddress: CONFIG.ERC8004_REGISTRY_PROGRAM,
          page,
          limit: 100,
          onlyVerified: false,
        }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];
    if (items.length === 0) { hasMore = false; break; }
    for (const item of items) {
      const agent = parse8004Asset(item);
      if (agent) agents.push(agent);
    }
    page++;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[8004 Sync] getAssetsByCreator returned ${agents.length} agents`);
  return agents;
}

async function fetch8004FromProgramAccounts(limit = 500) {
  const response = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getProgramAccounts',
      params: [
        CONFIG.ERC8004_REGISTRY_PROGRAM,
        { encoding: 'base64', commitment: 'confirmed' }
      ]
    })
  });
  const result = await response.json();
  const accounts = result?.result || [];
  console.log(`[8004 Sync] getProgramAccounts found ${accounts.length} accounts`);
  
  const agents = [];
  for (const account of accounts) {
    try {
      const buf = Buffer.from(account.account.data[0], 'base64');
      // Agent PDAs: 8-byte disc + 32-byte asset pubkey + 32-byte owner
      if (buf.length >= 72) {
        const assetId = encodeBase58(buf.slice(8, 40));
        const ownerWallet = encodeBase58(buf.slice(40, 72));
        if (ownerWallet && ownerWallet.length >= 32 && ownerWallet.length <= 44) {
          agents.push({
            assetId: assetId || account.pubkey,
            wallet: ownerWallet,
            name: null,
            description: null,
            image: null,
            jsonUri: null,
            services: [],
            skills: [],
            rawMetadata: null,
            source: 'erc8004',
            fetchedAt: new Date().toISOString(),
          });
        }
      }
    } catch (e) { /* skip */ }
    if (agents.length >= limit) break;
  }
  console.log(`[8004 Sync] Extracted ${agents.length} agents from program accounts`);
  return agents;
}

/**
 * Parse a Helius DAS asset into a normalized 8004 agent object.
 */
function parse8004Asset(item) {
  if (!item?.id) return null;

  const content = item.content || {};
  const metadata = content.metadata || {};
  const jsonUri = content.json_uri || '';

  // Extract owner wallet (the agent's authority/owner)
  const owner = item.ownership?.owner || null;

  return {
    assetId: item.id,
    wallet: owner,
    name: metadata.name || null,
    description: metadata.description || null,
    image: content.links?.image || metadata.image || null,
    jsonUri,
    // We'll resolve full metadata from IPFS/URI in enrichment step
    services: [],
    skills: [],
    rawMetadata: null,
    source: 'erc8004',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Resolve an agent's registration file from its URI (IPFS or HTTPS).
 * Returns the parsed JSON or null on failure.
 */
async function resolve8004Metadata(uri) {
  if (!uri) return null;

  try {
    // Convert IPFS URIs to HTTP gateway
    let url = uri;
    if (uri.startsWith('ipfs://')) {
      const cid = uri.replace('ipfs://', '');
      url = `https://gateway.pinata.cloud/ipfs/${cid}`;
    }

    const response = await fetch(url, {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

/**
 * Full sync: fetch 8004 agents, resolve metadata, extract wallets,
 * and import into FairScale registry for scoring.
 */
async function syncFrom8004() {
  console.log('[8004 Sync] Starting...');

  try {
    // fetch8004Agents now handles all query strategies internally
    // (config PDA -> collection, creator fallback, getProgramAccounts fallback)
    let rawAgents = await fetch8004Agents(500);

    if (rawAgents.length === 0) {
      console.log('[8004 Sync] No agents found. Will retry next cycle.');
      return;
    }

    console.log(`[8004 Sync] Found ${rawAgents.length} raw agents, enriching...`);

    let imported = 0;
    let enriched = 0;
    let failed = 0;

    for (const agent of rawAgents) {
      try {
        // Store the raw 8004 agent
        REGISTRY.erc8004Agents.set(agent.assetId, agent);

        // Resolve IPFS metadata to get full registration file
        if (agent.jsonUri) {
          const meta = await resolve8004Metadata(agent.jsonUri);
          if (meta) {
            agent.rawMetadata = meta;
            agent.name = meta.name || agent.name;
            agent.description = meta.description || agent.description;
            agent.image = meta.image || agent.image;

            // Extract services from 8004 registration file
            if (Array.isArray(meta.services)) {
              agent.services = meta.services.map(s => ({
                name: s.name || s.type || 'unknown',
                endpoint: s.endpoint || s.value || '',
              }));
            }

            // Extract skills/domains if present
            if (Array.isArray(meta.skills)) agent.skills = meta.skills;

            enriched++;
          }
        }

        // If the agent has a wallet, score it with FairScale
        if (agent.wallet) {
          const existing = REGISTRY.agents.get(agent.wallet);
          if (!existing || Date.now() - new Date(existing.lastUpdated).getTime() > 600000) {
            const scored = await getOrCreateAgent(agent.wallet);
            if (scored) {
              // Tag it as an 8004 agent
              scored.erc8004 = {
                assetId: agent.assetId,
                name: agent.name,
                services: agent.services,
                skills: agent.skills,
              };
              imported++;
            }
          } else {
            // Update existing with 8004 metadata
            existing.erc8004 = {
              assetId: agent.assetId,
              name: agent.name,
              services: agent.services,
              skills: agent.skills,
            };
            imported++;
          }
        }

        // Rate limit: don't hammer FairScale API
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        failed++;
      }
    }

    console.log(`[8004 Sync] Complete: ${imported} scored, ${enriched} metadata resolved, ${failed} failed out of ${rawAgents.length} total`);
    REGISTRY.lastErc8004Sync = new Date().toISOString();
  } catch (e) {
    console.error('[8004 Sync] Error:', e.message);
  }
}

// =============================================================================
// 8004 ROUTES
// =============================================================================

// List all 8004 agents we've synced (raw from registry)
app.get('/8004/agents', (req, res) => {
  const agents = Array.from(REGISTRY.erc8004Agents.values());
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const page = agents.slice(offset, offset + limit);

  res.json({
    source: 'solana-agent-registry-8004',
    total: agents.length,
    limit,
    offset,
    lastSync: REGISTRY.lastErc8004Sync,
    agents: page.map(a => ({
      assetId: a.assetId,
      wallet: a.wallet,
      name: a.name,
      description: a.description,
      image: a.image,
      services: a.services,
      skills: a.skills,
      source: a.source,
      fetchedAt: a.fetchedAt,
    }))
  });
});

// Get a single 8004 agent by asset ID with FairScale scoring
app.get('/8004/agent/:assetId', async (req, res) => {
  const { assetId } = req.params;

  const cached = REGISTRY.erc8004Agents.get(assetId);
  if (!cached) {
    return res.status(404).json({ error: 'Agent not found in 8004 registry' });
  }

  // If the agent has a wallet, include FairScale score
  let fairscaleScore = null;
  if (cached.wallet) {
    const agent = await getOrCreateAgent(cached.wallet);
    if (agent) {
      fairscaleScore = {
        agent_fairscore: agent.scores.agent_fairscore,
        fairscore_base: agent.scores.fairscore_base,
        features: agent.features,
        descriptions: agent.descriptions,
      };
    }
  }

  res.json({
    source: 'solana-agent-registry-8004',
    agent: {
      assetId: cached.assetId,
      wallet: cached.wallet,
      name: cached.name,
      description: cached.description,
      image: cached.image,
      services: cached.services,
      skills: cached.skills,
      rawMetadata: cached.rawMetadata,
    },
    fairscale: fairscaleScore,
  });
});

// Trigger a manual 8004 sync (admin)
app.post('/admin/sync-8004', async (req, res) => {
  const { apiKey } = req.body;
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Run sync in background, respond immediately
  syncFrom8004();

  res.json({
    success: true,
    message: '8004 sync started',
    currentCount: REGISTRY.erc8004Agents.size,
    lastSync: REGISTRY.lastErc8004Sync,
  });
});

// =============================================================================
// PAYMENT VERIFICATION
// =============================================================================

async function verifyPayment(senderWallet) {
  if (!CONFIG.HELIUS_API_KEY) {
    return { verified: false, error: 'Payment verification not configured' };
  }
  
  try {
    const sigResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [CONFIG.PAYMENT_ADDRESS, { limit: 100 }]
      })
    });
    
    const sigData = await sigResponse.json();
    const signatures = sigData.result || [];
    
    for (const sig of signatures) {
      const txResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      
      const txData = await txResponse.json();
      const tx = txData.result;
      if (!tx?.meta || tx.meta.err) continue;
      
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      
      for (const post of postBalances) {
        if (post.mint !== CONFIG.USDC_MINT || post.owner !== CONFIG.PAYMENT_ADDRESS) continue;
        
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmount = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        
        if (postAmount - preAmount >= CONFIG.VERIFICATION_AMOUNT) {
          const accountKeys = tx.transaction?.message?.accountKeys || [];
          if (accountKeys.some(k => (typeof k === 'string' ? k : k.pubkey) === senderWallet)) {
            return { verified: true, txSignature: sig.signature };
          }
        }
      }
    }
    
    return { verified: false, error: 'No payment found. Send $5 USDC and try again.' };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

// =============================================================================
// SCORING - USE FAIRSCALE DATA DIRECTLY
// =============================================================================

function scale(value, max, curve = 1.5) {
  // Soft curve for diminishing returns, always 10-100
  const normalized = Math.min(value / max, 1);
  const scaled = Math.pow(normalized, 1 / curve) * 100;
  return Math.min(Math.max(Math.round(scaled), 10), 100);
}

function percentileToScore(percentile) {
  // Percentiles are already 0-100 scale from FairScale, cap just in case
  return Math.min(Math.max(Math.round(percentile), 10), 100);
}

// =============================================================================
// AGENT METRICS - DIRECTLY FROM FAIRSCALE FEATURES
// =============================================================================

function calculateAgentFeatures(fairscaleData) {
  const f = fairscaleData?.features || {};
  
  // ==========================================================================
  // ACTIVITY - tx_count, active_days, platform_diversity
  // ==========================================================================
  
  const txCount = f.tx_count || 0;
  const activeDays = f.active_days || 0;
  const platformDiversity = f.platform_diversity || 0;
  
  const txScore = scale(txCount, 150, 1.8);
  const activeScore = scale(activeDays, 30, 1.5);
  const diversityScore = scale(platformDiversity, 5, 1.5);
  
  const activity = Math.min(Math.max(Math.round((txScore * 0.5) + (activeScore * 0.3) + (diversityScore * 0.2)), 10), 100);
  
  // ==========================================================================
  // HOLDINGS - percentile scores (already 0-100 from FairScale)
  // ==========================================================================
  
  const lstPercentile = f.lst_percentile_score || 0;
  const majorPercentile = f.major_percentile_score || 0;
  const stablePercentile = f.stable_percentile_score || 0;
  const solPercentile = f.native_sol_percentile || 0;
  
  const holdings = Math.min(Math.max(Math.round(
    (percentileToScore(lstPercentile) * 0.3) +
    (percentileToScore(majorPercentile) * 0.3) +
    (percentileToScore(stablePercentile) * 0.2) +
    (percentileToScore(solPercentile) * 0.2)
  ), 10), 100);
  
  // ==========================================================================
  // RELIABILITY - no_instant_dumps, conviction_ratio, tempo patterns
  // ==========================================================================
  
  const noInstantDumps = f.no_instant_dumps || 0; // 0-1
  const convictionRatio = f.conviction_ratio || 0; // 0-1
  const tempoCV = f.tempo_cv || 0;
  const burstRatio = f.burst_ratio || 0;
  
  const dumpScore = Math.min(Math.max(noInstantDumps * 100, 10), 100);
  const convictionScore = Math.min(Math.max(convictionRatio * 100, 10), 100);
  
  // Lower tempo CV and burst ratio = more predictable = better
  const patternScore = Math.min(Math.max(
    tempoCV > 0 || burstRatio > 0 
      ? 100 - (tempoCV * 20) - (burstRatio * 30)
      : 50,
    10
  ), 100);
  
  const reliability = Math.min(Math.max(Math.round(
    (dumpScore * 0.4) + (convictionScore * 0.3) + (patternScore * 0.3)
  ), 10), 100);
  
  // ==========================================================================
  // HISTORY - wallet_age_score, median_hold_days
  // ==========================================================================
  
  const walletAgeScore = f.wallet_age_score || 0;
  const medianHoldDays = f.median_hold_days || 0;
  
  const ageScore = Math.min(Math.max(walletAgeScore, 10), 100);
  const holdScore = Math.min(scale(medianHoldDays, 30, 1.5), 100);
  
  const history = Math.min(Math.max(Math.round((ageScore * 0.6) + (holdScore * 0.4)), 10), 100);
  
  return {
    activity,
    holdings,
    reliability,
    history
  };
}

// =============================================================================
// FEATURE DESCRIPTIONS
// =============================================================================

function getFeatureDescription(feature, value) {
  const descriptions = {
    activity: {
      high: 'High transaction volume across multiple protocols',
      mid: 'Moderate on-chain activity',
      low: 'Limited transaction history'
    },
    holdings: {
      high: 'Strong token positions (SOL, LST, stables)',
      mid: 'Moderate token holdings',
      low: 'Minimal token positions'
    },
    reliability: {
      high: 'No panic sells, consistent behavior',
      mid: 'Generally stable patterns',
      low: 'Variable transaction patterns'
    },
    history: {
      high: 'Established wallet with holding history',
      mid: 'Some track record',
      low: 'New or limited history'
    }
  };
  
  const tier = value >= 50 ? 'high' : value >= 25 ? 'mid' : 'low';
  return descriptions[feature]?.[tier] || '';
}

// =============================================================================
// AGENT FAIRSCORE CALCULATION
// =============================================================================

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
  // FairScale's score (40%)
  const fsScore = fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0;
  const fsComponent = fsScore * 0.40;
  
  // Our metrics (30%)
  const featureAvg = (features.activity + features.holdings + features.reliability + features.history) / 4;
  const featureComponent = featureAvg * 0.30;
  
  // SAID reputation (20%)
  const saidScore = saidData?.reputation?.score || 0;
  const saidComponent = saidScore * 0.20;
  
  // Bonuses (up to 10%)
  let bonuses = 0;
  if (saidData?.verified) bonuses += 2;
  if (saidData?.reputation?.trustTier === 'high') bonuses += 3;
  
  // Attestations: +5 per attestation, up to 15
  const attestations = saidData?.reputation?.feedbackCount || 0;
  bonuses += Math.min(attestations * 5, 15);
  
  if (REGISTRY.registeredAgents.has(wallet)) bonuses += 2;
  if (REGISTRY.verifiedWallets.has(wallet)) bonuses += 5;
  
  const total = fsComponent + featureComponent + saidComponent + Math.min(bonuses, 15);
  
  // Minimum score is 10
  return Math.max(Math.min(Math.round(total), 100), 10);
}

// =============================================================================
// AGENT MANAGEMENT
// =============================================================================

async function getOrCreateAgent(wallet) {
  if (REGISTRY.agents.has(wallet)) {
    const cached = REGISTRY.agents.get(wallet);
    if (Date.now() - new Date(cached.lastUpdated).getTime() < 300000) {
      return cached;
    }
  }
  
  const [fairscaleData, saidData] = await Promise.all([
    getFairScaleScore(wallet),
    getSAIDData(wallet)
  ]);
  
  if (!fairscaleData && !saidData) return null;
  
  const features = calculateAgentFeatures(fairscaleData);
  const regData = REGISTRY.registeredAgents.get(wallet);
  
  // Fetch ClawKey human verification if deviceId is on file
  const verifications = {};
  try {
    const deviceId = regData?.clawkeyDeviceId || null;
    if (deviceId) {
      verifications.clawkey = await getClawKeyVerification(deviceId);
    }
  } catch (e) { console.error('[Verifications]', e.message); }
  
  const agentFairScore = calculateAgentFairScore(fairscaleData, features, saidData, wallet, verifications);
  
  const agent = {
    wallet,
    name: regData?.name || saidData?.identity?.name || null,
    description: regData?.description || saidData?.identity?.description || null,
    website: regData?.website || saidData?.identity?.website || null,
    mcp: regData?.mcp || saidData?.endpoints?.mcp || null,
    scores: {
      agent_fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore_base || fairscaleData?.fairscore || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: saidData?.reputation?.feedbackCount || 0
    },
    features: {
      activity: features.activity,
      holdings: features.holdings,
      reliability: features.reliability,
      history: features.history
    },
    descriptions: {
      activity: getFeatureDescription('activity', features.activity),
      holdings: getFeatureDescription('holdings', features.holdings),
      reliability: getFeatureDescription('reliability', features.reliability),
      history: getFeatureDescription('history', features.history)
    },
    isRegistered: REGISTRY.registeredAgents.has(wallet),
    isSaidAgent: REGISTRY.saidAgents.has(wallet),
    isVerified: REGISTRY.verifiedWallets.has(wallet),
    verifications: {
      clawkey: verifications.clawkey ? { verified: verifications.clawkey.verified, humanId: verifications.clawkey.humanId } : null,
      said_onchain: REGISTRY.saidAgents.has(wallet),
      erc8004: REGISTRY.erc8004Agents.has(wallet),
    },
    services: Array.from(REGISTRY.services.values()).filter(s => s.wallet === wallet),
    lastUpdated: new Date().toISOString()
  };
  
  REGISTRY.agents.set(wallet, agent);
  return agent;
}

// =============================================================================
// PUBLIC SCORING API — v1
// =============================================================================
// Designed for external consumption by 8004scan, SATI, AgentWallet, Solana
// Foundation, or any platform that needs real-time wallet trust scoring.
// No API key required (read-only). Rate-limit friendly.
// =============================================================================

/**
 * GET /v1/score?wallet=<address>
 * 
 * Returns a FairScale trust score for any Solana wallet.
 * Designed for integration by agent registries, marketplaces, and protocols.
 * 
 * Response:
 * {
 *   wallet: string,
 *   fairscore: number (10-100),
 *   tier: "bronze" | "silver" | "gold",
 *   features: { activity, holdings, reliability, history },
 *   signals: { ... },
 *   meta: { provider, version, scored_at, cache_ttl }
 * }
 */
app.get('/v1/score', async (req, res) => {
  const { wallet } = req.query;

  if (!wallet) {
    return res.status(400).json({
      error: 'missing_wallet',
      message: 'Provide ?wallet=<solana_address>',
      docs: 'https://docs.fairscale.xyz/api/v1/score',
    });
  }

  if (wallet.length < 32 || wallet.length > 44) {
    return res.status(400).json({
      error: 'invalid_wallet',
      message: 'Wallet address must be a valid Solana public key (32-44 chars)',
    });
  }

  try {
    const agent = await getOrCreateAgent(wallet);

    if (!agent) {
      return res.status(502).json({
        error: 'scoring_unavailable',
        message: 'Could not retrieve scoring data for this wallet. Try again shortly.',
        wallet,
      });
    }

    const score = agent.scores.agent_fairscore;
    const tier = score >= 70 ? 'gold' : score >= 40 ? 'silver' : 'bronze';

    // Check if this wallet is a registered 8004 agent
    const erc8004 = agent.erc8004 || null;

    res.json({
      wallet,
      fairscore: score,
      tier,
      features: {
        activity: agent.features.activity,
        holdings: agent.features.holdings,
        reliability: agent.features.reliability,
        history: agent.features.history,
      },
      signals: {
        fairscore_base: agent.scores.fairscore_base,
        said_score: agent.scores.said_score,
        said_trust_tier: agent.scores.said_trust_tier,
        attestations: agent.scores.attestations,
        is_registered: agent.isRegistered,
        is_verified: agent.isVerified,
        is_erc8004: !!erc8004,
      },
      erc8004: erc8004 ? {
        asset_id: erc8004.assetId,
        name: erc8004.name,
        services: erc8004.services,
      } : null,
      meta: {
        provider: 'FairScale',
        version: 'v1',
        scored_at: agent.lastUpdated,
        cache_ttl: 300,
        docs: 'https://docs.fairscale.xyz/api/v1',
      }
    });
  } catch (e) {
    console.error('v1/score error:', e.message);
    res.status(500).json({
      error: 'internal_error',
      message: 'Scoring failed. Please retry.',
    });
  }
});

/**
 * POST /v1/score/batch
 * 
 * Score multiple wallets in one request (max 25).
 * Useful for directory pages, leaderboards, portfolio views.
 * 
 * Body: { wallets: ["addr1", "addr2", ...] }
 */
app.post('/v1/score/batch', async (req, res) => {
  const { wallets } = req.body;

  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({
      error: 'missing_wallets',
      message: 'Provide { wallets: ["addr1", "addr2", ...] }',
    });
  }

  if (wallets.length > 25) {
    return res.status(400).json({
      error: 'too_many_wallets',
      message: 'Maximum 25 wallets per batch request',
    });
  }

  const results = [];

  for (const wallet of wallets) {
    if (!wallet || wallet.length < 32 || wallet.length > 44) {
      results.push({ wallet, error: 'invalid_wallet' });
      continue;
    }

    try {
      const agent = await getOrCreateAgent(wallet);
      if (!agent) {
        results.push({ wallet, error: 'scoring_unavailable' });
        continue;
      }

      const score = agent.scores.agent_fairscore;
      results.push({
        wallet,
        fairscore: score,
        tier: score >= 70 ? 'gold' : score >= 40 ? 'silver' : 'bronze',
        features: {
          activity: agent.features.activity,
          holdings: agent.features.holdings,
          reliability: agent.features.reliability,
          history: agent.features.history,
        },
      });
    } catch (e) {
      results.push({ wallet, error: 'scoring_failed' });
    }
  }

  res.json({
    total: wallets.length,
    scored: results.filter(r => !r.error).length,
    results,
    meta: {
      provider: 'FairScale',
      version: 'v1',
      scored_at: new Date().toISOString(),
    }
  });
});

/**
 * GET /v1/health
 * 
 * Health check for monitoring and integration testing.
 */
app.get('/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FairScale Scoring API',
    version: 'v1',
    uptime: Math.floor(process.uptime()),
    registry: {
      agents: REGISTRY.agents.size,
      erc8004: REGISTRY.erc8004Agents.size,
      services: REGISTRY.services.size,
    },
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '10.0.0',
    description: 'The Trust & Discovery Layer for Solana AI Agents',
    api: {
      v1: {
        'GET /v1/score?wallet=': 'Score any Solana wallet (public, no auth)',
        'POST /v1/score/batch': 'Score up to 25 wallets in one call',
        'GET /v1/health': 'API health check',
      }
    },
    endpoints: {
      'GET /score': 'Get agent score by wallet (legacy)',
      'POST /register': 'Register agent',
      'POST /verify': 'Verify payment',
      'POST /service': 'Register x402 service',
      'GET /services': 'List services',
      'GET /directory': 'List all agents (supports ?source=8004|fairscale)',
      'GET /stats': 'Registry statistics',
      'GET /8004/agents': 'List agents from Solana Agent Registry (ERC-8004)',
      'GET /8004/agent/:assetId': 'Get 8004 agent with FairScale score',
      'POST /admin/sync-8004': 'Trigger 8004 sync (admin)',
      'POST /admin/sync-said': 'Trigger SAID sync (admin)',
      'POST /admin/bulk-import': 'Bulk import wallets (admin)',
    },
    integrations: {
      erc8004: 'Solana Agent Registry (8004-solana)',
      said: 'SAID Protocol',
      fairscale: 'FairScale Scoring Engine',
    }
  });
});

app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  const agent = await getOrCreateAgent(wallet);
  if (!agent) return res.status(404).json({ error: 'Could not fetch data', wallet });
  
  res.json({
    wallet,
    name: agent.name || `Agent ${wallet.slice(0, 8)}...`,
    description: agent.description,
    website: agent.website,
    mcp: agent.mcp,
    agent_fairscore: agent.scores.agent_fairscore,
    fairscore_base: agent.scores.fairscore_base,
    features: agent.features,
    descriptions: agent.descriptions,
    said: {
      score: agent.scores.said_score,
      trustTier: agent.scores.said_trust_tier,
      feedbackCount: agent.scores.attestations
    },
    isRegistered: agent.isRegistered,
    isVerified: agent.isVerified,
    services: agent.services
  });
});

app.post('/register', async (req, res) => {
  const { wallet, name, description, website, mcp, clawkeyDeviceId } = req.body;
  
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  // If ClawKey deviceId provided, verify it before storing
  let clawkeyResult = null;
  if (clawkeyDeviceId) {
    clawkeyResult = await getClawKeyVerification(clawkeyDeviceId);
    console.log(`[Register] ClawKey verification for ${wallet}: ${clawkeyResult?.verified ? 'VERIFIED' : 'not verified'}`);
  }
  
  REGISTRY.registeredAgents.set(wallet, {
    wallet, name, description, website, mcp,
    clawkeyDeviceId: clawkeyDeviceId || null,
    clawkeyVerified: clawkeyResult?.verified || false,
    registeredAt: new Date().toISOString()
  });
  
  REGISTRY.agents.delete(wallet);
  const agent = await getOrCreateAgent(wallet);
  
  res.json({
    success: true,
    message: 'Agent registered',
    agent: agent ? {
      wallet,
      name: agent.name,
      agent_fairscore: agent.scores.agent_fairscore
    } : null
  });
});

app.post('/service', async (req, res) => {
  const { wallet, url, name, description, price, category } = req.body;
  
  if (!wallet || !url || !name) {
    return res.status(400).json({ error: 'Missing wallet, url, or name' });
  }
  
  const serviceId = `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  REGISTRY.services.set(serviceId, {
    id: serviceId,
    wallet,
    url,
    name,
    description: description || '',
    price: price || 'Contact',
    category: category || 'utility',
    network: 'solana',
    registeredAt: new Date().toISOString()
  });
  
  res.json({ success: true, serviceId, message: 'Service registered' });
});

app.post('/verify', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  if (REGISTRY.verifiedWallets.has(wallet)) {
    return res.json({ success: true, message: 'Already verified' });
  }
  
  const result = await verifyPayment(wallet);
  
  if (result.verified) {
    REGISTRY.verifiedWallets.set(wallet, {
      verifiedAt: new Date().toISOString(),
      txSignature: result.txSignature
    });
    REGISTRY.agents.delete(wallet);
    return res.json({ success: true, message: '+8 score boost applied', txSignature: result.txSignature });
  }
  
  res.status(400).json({ success: false, error: result.error, paymentAddress: CONFIG.PAYMENT_ADDRESS });
});

app.get('/services', (req, res) => {
  const services = Array.from(REGISTRY.services.values());
  res.json({ total: services.length, network: 'solana', services });
});

app.get('/directory', (req, res) => {
  const source = req.query.source; // Optional filter: 'fairscale', '8004', 'said', or omit for all
  
  const agents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered || a.erc8004 || REGISTRY.saidAgents.has(a.wallet))
    .filter(a => {
      if (source === '8004') return !!a.erc8004;
      if (source === 'said') return REGISTRY.saidAgents.has(a.wallet) && !a.isRegistered && !a.erc8004;
      if (source === 'fairscale') return a.isRegistered && !a.erc8004;
      return true;
    })
    .sort((a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore)
    .slice(0, 200)
    .map(a => ({
      wallet: a.wallet,
      name: a.erc8004?.name || a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      agent_fairscore: a.scores.agent_fairscore,
      isVerified: a.isVerified,
      humanVerified: a.verifications?.clawkey?.verified || false,
      services: a.services.length + (a.erc8004?.services?.length || 0),
      source: a.erc8004 ? 'erc8004' : REGISTRY.saidAgents.has(a.wallet) ? 'said' : 'fairscale',
      erc8004AssetId: a.erc8004?.assetId || null,
      saidPda: REGISTRY.saidAgents.get(a.wallet)?.pda || null,
    }));
  
  res.json({ total: agents.length, agents });
});

// Bulk import agents (admin)
app.post('/admin/bulk-import', async (req, res) => {
  const { wallets, apiKey } = req.body;
  
  // Simple API key check - change this to your own secret
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({ error: 'wallets must be a non-empty array' });
  }
  
  const results = { success: [], failed: [] };
  
  for (const wallet of wallets) {
    try {
      const agent = await getOrCreateAgent(wallet);
      if (agent) {
        results.success.push({
          wallet,
          score: agent.scores.agent_fairscore
        });
      } else {
        results.failed.push({ wallet, reason: 'Could not fetch data' });
      }
    } catch (e) {
      results.failed.push({ wallet, reason: e.message });
    }
  }
  
  res.json({
    imported: results.success.length,
    failed: results.failed.length,
    results
  });
});

// Sync all agents from SAID Protocol
app.post('/admin/sync-said', async (req, res) => {
  const { apiKey } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  try {
    // Fetch all agents from SAID
    const saidResponse = await fetch(`${CONFIG.SAID_API}/api/agents?limit=500`);
    if (!saidResponse.ok) {
      return res.status(500).json({ error: 'Failed to fetch from SAID API' });
    }
    
    const saidData = await saidResponse.json();
    const agents = saidData.agents || saidData.data || saidData || [];
    
    if (!Array.isArray(agents)) {
      return res.status(500).json({ error: 'Unexpected SAID response format', raw: saidData });
    }
    
    const results = { success: [], failed: [] };
    
    for (const agent of agents) {
      const wallet = agent.wallet || agent.walletAddress || agent.address;
      if (!wallet) {
        results.failed.push({ agent, reason: 'No wallet found' });
        continue;
      }
      
      try {
        const imported = await getOrCreateAgent(wallet);
        if (imported) {
          results.success.push({
            wallet,
            name: agent.name || imported.name,
            score: imported.scores.agent_fairscore
          });
        } else {
          results.failed.push({ wallet, reason: 'Could not fetch FairScale data' });
        }
      } catch (e) {
        results.failed.push({ wallet, reason: e.message });
      }
    }
    
    res.json({
      source: 'SAID Protocol',
      total_found: agents.length,
      imported: results.success.length,
      failed: results.failed.length,
      results
    });
    
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/stats', (req, res) => {
  res.json({
    agents: REGISTRY.agents.size,
    registered: REGISTRY.registeredAgents.size,
    verified: REGISTRY.verifiedWallets.size,
    services: REGISTRY.services.size,
    erc8004Agents: REGISTRY.erc8004Agents.size,
    lastErc8004Sync: REGISTRY.lastErc8004Sync,
    lastSaidSync: REGISTRY.lastSync || null,
  });
});

// =============================================================================
// SAID AUTO-SYNC
// =============================================================================

async function syncFromSAID() {
  console.log('[SAID Sync] Starting...');
  
  try {
    const saidResponse = await fetch(`${CONFIG.SAID_API}/api/agents?limit=500`);
    if (!saidResponse.ok) {
      console.error('[SAID Sync] Failed to fetch:', saidResponse.status);
      return;
    }
    
    const saidData = await saidResponse.json();
    const agents = saidData.agents || saidData.data || saidData || [];
    
    if (!Array.isArray(agents)) {
      console.error('[SAID Sync] Unexpected response format');
      return;
    }
    
    let imported = 0;
    let failed = 0;
    
    for (const agent of agents) {
      const wallet = agent.wallet || agent.walletAddress || agent.address;
      if (!wallet) {
        failed++;
        continue;
      }
      
      try {
        const result = await getOrCreateAgent(wallet);
        if (result) imported++;
        else failed++;
      } catch (e) {
        failed++;
      }
      
      // Small delay to avoid hammering APIs
      await new Promise(r => setTimeout(r, 200));
    }
    
    console.log(`[SAID Sync] Complete: ${imported} imported, ${failed} failed`);
    REGISTRY.lastSync = new Date().toISOString();
    
  } catch (e) {
    console.error('[SAID Sync] Error:', e.message);
  }
}

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Registry v10.0 on port ${CONFIG.PORT}`);
  console.log(`  Integrations: FairScale API, SAID Protocol, ERC-8004 (Solana Agent Registry)`);
  
  // Sync from SAID on startup (after 5 second delay)
  setTimeout(syncFromSAID, 5000);
  
  // Sync from 8004 on startup (after 15 second delay — let SAID go first)
  setTimeout(syncFrom8004, 15000);
  
  // Re-sync SAID daily (every 24 hours)
  setInterval(syncFromSAID, 24 * 60 * 60 * 1000);
  
  // Re-sync 8004 every 6 hours (more agents, higher value)
  setInterval(syncFrom8004, 6 * 60 * 60 * 1000);
});
