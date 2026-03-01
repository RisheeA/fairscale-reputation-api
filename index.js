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
  X402_BAZAAR_API: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
  X402_COMMUNITY_API: 'https://x402-discovery-api.onrender.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  HELIUS_RPC: 'https://mainnet.helius-rpc.com',
  PAYMENT_ADDRESS: 'fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  VERIFICATION_AMOUNT: 5,
  PORT: process.env.PORT || 8080
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  services: new Map(),
  verifiedWallets: new Map(),
  lastSync: null
};

// =============================================================================
// BADGE DEFINITIONS
// =============================================================================

const BADGE_DEFINITIONS = {
  established: { label: 'Established', description: 'Wallet active for extended period' },
  committed: { label: 'Committed', description: 'Holds positions long-term' },
  capitalised: { label: 'Capitalised', description: 'Significant token holdings' },
  diverse: { label: 'Diverse', description: 'Interacts across multiple protocols' },
  experienced: { label: 'Experienced', description: 'High transaction volume' },
  holder: { label: 'Holder', description: 'Maintains positions for extended periods' },
  social: { label: 'Social', description: 'Verified social presence' },
  attested: { label: 'Attested', description: 'Has received attestations' },
  trusted_by_many: { label: 'Trusted by Many', description: 'Multiple positive attestations' },
  said_verified: { label: 'SAID Verified', description: 'Identity verified through SAID' },
  said_trusted: { label: 'SAID Trusted', description: 'High trust tier on SAID' },
  x402_enabled: { label: 'x402 Enabled', description: 'Offers paid services via x402' },
  mcp_available: { label: 'MCP Available', description: 'Has MCP endpoint' },
  fairscale_verified: { label: 'FairScale Verified', description: 'Paid verification on FairScale' }
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
    console.error('FairScale API error:', e.message);
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
    console.error('SAID API error:', e.message);
    return null;
  }
}

async function getX402BazaarServices() {
  try {
    const response = await fetch(`${CONFIG.X402_BAZAAR_API}?limit=100`, { headers: { 'accept': 'application/json' } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (e) {
    console.error('x402 Bazaar error:', e.message);
    return [];
  }
}

async function getX402CommunityServices() {
  try {
    const response = await fetch(`${CONFIG.X402_COMMUNITY_API}/services`, { headers: { 'accept': 'application/json' } });
    if (!response.ok) return [];
    return await response.json();
  } catch (e) {
    console.error('x402 Community error:', e.message);
    return [];
  }
}

// =============================================================================
// PAYMENT VERIFICATION VIA HELIUS
// =============================================================================

async function verifyPayment(senderWallet) {
  if (!CONFIG.HELIUS_API_KEY) {
    return { verified: false, error: 'Payment verification not configured. Add HELIUS_API_KEY.' };
  }
  
  try {
    // Get recent transactions to payment address
    const sigResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [CONFIG.PAYMENT_ADDRESS, { limit: 100 }]
      })
    });
    
    const sigData = await sigResponse.json();
    const signatures = sigData.result || [];
    
    // Check each transaction for USDC from sender
    for (const sig of signatures) {
      const txResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      
      const txData = await txResponse.json();
      const tx = txData.result;
      if (!tx || !tx.meta || tx.meta.err) continue;
      
      // Check token balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      
      for (const post of postBalances) {
        if (post.mint !== CONFIG.USDC_MINT) continue;
        if (post.owner !== CONFIG.PAYMENT_ADDRESS) continue;
        
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmount = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        const diff = postAmount - preAmount;
        
        if (diff >= CONFIG.VERIFICATION_AMOUNT) {
          // Check if sender wallet is in the transaction
          const accountKeys = tx.transaction?.message?.accountKeys || [];
          const senderInTx = accountKeys.some(k => {
            const key = typeof k === 'string' ? k : k.pubkey;
            return key === senderWallet;
          });
          
          if (senderInTx) {
            return { verified: true, txSignature: sig.signature, amount: diff, timestamp: sig.blockTime };
          }
        }
      }
    }
    
    return { verified: false, error: 'No matching payment found. Send $5 USDC and try again.' };
  } catch (e) {
    console.error('Payment verification error:', e);
    return { verified: false, error: e.message };
  }
}

// =============================================================================
// SCORE CALCULATIONS - USING CORRECT FAIRSCALE API FIELDS
// =============================================================================

function calculateFeatures(fairscaleData) {
  // FairScale API returns data.features with these fields:
  // - major_percentile_score (0-1): percentile for major token holdings
  // - stable_percentile_score (0-1): percentile for stablecoin holdings
  // - lst_percentile_score (0-1): percentile for LST holdings
  // - active_days: number of active days in analysis window
  // - wallet_age_days: age of wallet in days
  // - tx_count: transaction count
  // - platform_diversity: number of unique protocols used
  // - conviction_ratio: holding behavior metric
  // - median_hold_days: median holding period
  // - no_instant_dumps: boolean/ratio for dump behavior
  
  const f = fairscaleData.features || {};
  
  // LONGEVITY: Wallet age and activity consistency
  const walletAgeDays = f.wallet_age_days || 0;
  const ageScore = Math.min((walletAgeDays / 365) * 100, 100); // Max at 1 year
  const activeDays = f.active_days || 0;
  const activityRatio = walletAgeDays > 0 ? Math.min((activeDays / walletAgeDays) * 100, 100) : 0;
  const longevity = Math.round((ageScore * 0.6) + (activityRatio * 0.4));
  
  // EXPERIENCE: Transaction count and protocol diversity
  const txCount = f.tx_count || 0;
  const txScore = Math.min((txCount / 500) * 100, 100); // Max at 500 txs
  const platformDiversity = f.platform_diversity || 0;
  const diversityScore = Math.min(platformDiversity * 10, 100); // Max at 10 platforms
  const experience = Math.round((txScore * 0.5) + (diversityScore * 0.5));
  
  // CONVICTION: Holding patterns
  const convictionRatio = (f.conviction_ratio || 0) * 100;
  const medianHold = Math.min((f.median_hold_days || 0) / 30 * 50, 50); // Max contribution at 30 days
  const noDumps = f.no_instant_dumps ? (typeof f.no_instant_dumps === 'boolean' ? 100 : f.no_instant_dumps * 100) : 50;
  const conviction = Math.round((convictionRatio * 0.4) + (medianHold * 0.3) + (noDumps * 0.3));
  
  // CAPITAL: Holdings percentiles
  const majorPct = (f.major_percentile_score || 0) * 100;
  const stablePct = (f.stable_percentile_score || 0) * 100;
  const lstPct = (f.lst_percentile_score || 0) * 100;
  const capital = Math.round((majorPct * 0.4) + (stablePct * 0.3) + (lstPct * 0.3));
  
  return {
    longevity: Math.min(Math.max(longevity, 0), 100),
    experience: Math.min(Math.max(experience, 0), 100),
    conviction: Math.min(Math.max(conviction, 0), 100),
    capital: Math.min(Math.max(capital, 0), 100)
  };
}

function calculateBadges(fairscaleData, saidData, wallet) {
  const f = fairscaleData?.features || {};
  const badges = [];
  
  // Feature-based badges
  if ((f.wallet_age_days || 0) >= 180) badges.push({ ...BADGE_DEFINITIONS.established, id: 'established' });
  if ((f.conviction_ratio || 0) >= 0.6) badges.push({ ...BADGE_DEFINITIONS.committed, id: 'committed' });
  if ((f.major_percentile_score || 0) >= 0.5) badges.push({ ...BADGE_DEFINITIONS.capitalised, id: 'capitalised' });
  if ((f.platform_diversity || 0) >= 5) badges.push({ ...BADGE_DEFINITIONS.diverse, id: 'diverse' });
  if ((f.tx_count || 0) >= 200) badges.push({ ...BADGE_DEFINITIONS.experienced, id: 'experienced' });
  if ((f.median_hold_days || 0) >= 14) badges.push({ ...BADGE_DEFINITIONS.holder, id: 'holder' });
  
  // SAID badges
  const feedbackCount = saidData?.reputation?.feedbackCount || 0;
  if (feedbackCount >= 1) badges.push({ ...BADGE_DEFINITIONS.attested, id: 'attested' });
  if (feedbackCount >= 5) badges.push({ ...BADGE_DEFINITIONS.trusted_by_many, id: 'trusted_by_many' });
  if (saidData?.verified) badges.push({ ...BADGE_DEFINITIONS.said_verified, id: 'said_verified' });
  if (saidData?.reputation?.trustTier === 'high') badges.push({ ...BADGE_DEFINITIONS.said_trusted, id: 'said_trusted' });
  
  // Endpoint badges
  if (saidData?.endpoints?.mcp) badges.push({ ...BADGE_DEFINITIONS.mcp_available, id: 'mcp_available' });
  
  // FairScale verification
  if (REGISTRY.verifiedWallets.has(wallet)) {
    badges.push({ ...BADGE_DEFINITIONS.fairscale_verified, id: 'fairscale_verified' });
  }
  
  return badges;
}

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
  // Start with FairScale base score
  const baseScore = fairscaleData?.fairscore || 0;
  
  // Feature-weighted component (our own calculation based on features)
  const featureScore = (features.longevity * 0.2) + (features.experience * 0.25) + 
                       (features.conviction * 0.25) + (features.capital * 0.3);
  
  // Blend: 60% base FairScale, 40% our feature calculation
  let score = (baseScore * 0.6) + (featureScore * 0.4);
  
  // SAID bonuses
  const feedbackCount = saidData?.reputation?.feedbackCount || 0;
  score += Math.min(feedbackCount * 2, 10); // Up to +10 for attestations
  if (saidData?.verified) score += 5;
  if (saidData?.reputation?.trustTier === 'high') score += 5;
  
  // FairScale verification bonus (+15)
  if (REGISTRY.verifiedWallets.has(wallet)) {
    score += 15;
  }
  
  return Math.min(Math.round(score), 100);
}

// =============================================================================
// AGENT MANAGEMENT
// =============================================================================

async function getOrCreateAgent(wallet) {
  // Check cache (5 min TTL)
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
  
  const features = fairscaleData ? calculateFeatures(fairscaleData) : { longevity: 0, experience: 0, conviction: 0, capital: 0 };
  const badges = calculateBadges(fairscaleData, saidData, wallet);
  const agentFairScore = calculateAgentFairScore(fairscaleData, features, saidData, wallet);
  
  const agent = {
    wallet,
    sources: [],
    name: saidData?.identity?.name || null,
    description: saidData?.identity?.description || null,
    social: {
      twitter: saidData?.identity?.twitter || null,
      website: saidData?.identity?.website || null
    },
    endpoints: {
      mcp: saidData?.endpoints?.mcp || null,
      a2a: saidData?.endpoints?.a2a || null
    },
    skills: saidData?.skills || [],
    scores: {
      fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: saidData?.reputation?.feedbackCount || 0
    },
    features,
    badges,
    registeredAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString()
  };
  
  if (fairscaleData) agent.sources.push('fairscale');
  if (saidData?.registered) agent.sources.push('said');
  
  REGISTRY.agents.set(wallet, agent);
  return agent;
}

// =============================================================================
// SERVICES SYNC
// =============================================================================

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

async function syncX402Services() {
  console.log('Syncing x402 services...');
  
  const [bazaarServices, communityServices] = await Promise.all([
    getX402BazaarServices(),
    getX402CommunityServices()
  ]);
  
  let added = 0;
  
  for (const svc of bazaarServices) {
    const serviceId = `bazaar_${generateId()}`;
    const rawPrice = svc.accepts?.[0]?.maxAmountRequired;
    // Convert from micro-units to dollars (USDC has 6 decimals)
    const priceUsd = rawPrice ? (parseFloat(rawPrice) / 1000000).toFixed(4) : null;
    
    const serviceRecord = {
      id: serviceId,
      source: 'x402_bazaar',
      resource: svc.resource,
      name: svc.metadata?.name || svc.resource?.split('/').pop() || 'API Endpoint',
      description: svc.metadata?.description || 'x402 pay-per-request endpoint',
      category: svc.metadata?.category || 'utility',
      pricing: {
        price: priceUsd ? `$${priceUsd}` : 'Contact',
        raw: rawPrice,
        network: svc.accepts?.[0]?.network || 'base'
      },
      discoveredAt: new Date().toISOString()
    };
    
    if (!Array.from(REGISTRY.services.values()).find(s => s.resource === svc.resource)) {
      REGISTRY.services.set(serviceId, serviceRecord);
      added++;
    }
  }
  
  for (const svc of communityServices) {
    const serviceId = `community_${generateId()}`;
    const serviceRecord = {
      id: serviceId,
      source: 'x402_community',
      resource: svc.url || svc.resource,
      name: svc.name || 'Community Service',
      description: svc.description || 'Community x402 service',
      category: svc.category || 'utility',
      pricing: {
        price: svc.price_usd ? `$${svc.price_usd}` : 'Contact',
        raw: svc.price_usd,
        network: svc.network || 'solana'
      },
      discoveredAt: new Date().toISOString()
    };
    
    if (!Array.from(REGISTRY.services.values()).find(s => s.resource === serviceRecord.resource)) {
      REGISTRY.services.set(serviceId, serviceRecord);
      added++;
    }
  }
  
  REGISTRY.lastSync = new Date().toISOString();
  console.log(`Synced ${added} new services. Total: ${REGISTRY.services.size}`);
  return { added, total: REGISTRY.services.size };
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '6.2.0',
    endpoints: {
      'GET /score': 'Full reputation score for a wallet',
      'GET /services': 'List x402 services',
      'POST /verify': 'Verify payment and boost score',
      'GET /verify/status/:wallet': 'Check verification status',
      'POST /sync': 'Sync x402 services'
    },
    verification: {
      address: CONFIG.PAYMENT_ADDRESS,
      amount: `$${CONFIG.VERIFICATION_AMOUNT} USDC`,
      boost: '+15 score'
    }
  });
});

app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  
  if (!wallet) {
    return res.status(400).json({ error: 'Missing wallet parameter' });
  }
  
  const agent = await getOrCreateAgent(wallet);
  
  if (!agent) {
    return res.status(500).json({ error: 'Failed to fetch score', wallet });
  }
  
  res.json({
    wallet,
    name: agent.name || `Agent ${wallet.slice(0, 8)}...`,
    agent_fairscore: agent.scores.fairscore,
    fairscore_base: agent.scores.fairscore_base,
    badges: agent.badges,
    features: agent.features,
    info: {
      name: agent.name,
      description: agent.description,
      skills: agent.skills || [],
      endpoints: agent.endpoints,
      attestations: {
        count: agent.scores.attestations,
        trustTier: agent.scores.said_trust_tier
      },
      tier: agent.scores.fairscore >= 80 ? 'gold' : agent.scores.fairscore >= 50 ? 'silver' : 'bronze'
    },
    social: agent.social,
    said: {
      registered: agent.sources.includes('said'),
      verified: agent.badges.some(b => b.id === 'said_verified'),
      score: agent.scores.said_score,
      trustTier: agent.scores.said_trust_tier,
      feedbackCount: agent.scores.attestations
    },
    isVerified: REGISTRY.verifiedWallets.has(wallet)
  });
});

// =============================================================================
// VERIFICATION ROUTES
// =============================================================================

app.post('/verify', async (req, res) => {
  const { wallet } = req.body;
  
  if (!wallet) {
    return res.status(400).json({ error: 'Missing wallet parameter' });
  }
  
  if (REGISTRY.verifiedWallets.has(wallet)) {
    return res.json({
      success: true,
      message: 'Already verified',
      verifiedAt: REGISTRY.verifiedWallets.get(wallet).verifiedAt
    });
  }
  
  const verification = await verifyPayment(wallet);
  
  if (verification.verified) {
    REGISTRY.verifiedWallets.set(wallet, {
      verifiedAt: new Date().toISOString(),
      txSignature: verification.txSignature,
      amount: verification.amount
    });
    
    // Clear cache to recalculate score
    REGISTRY.agents.delete(wallet);
    
    return res.json({
      success: true,
      message: 'Verified! +15 score boost applied.',
      txSignature: verification.txSignature,
      amount: verification.amount
    });
  }
  
  res.status(400).json({
    success: false,
    error: verification.error || 'Payment not found',
    paymentAddress: CONFIG.PAYMENT_ADDRESS,
    requiredAmount: `$${CONFIG.VERIFICATION_AMOUNT} USDC`
  });
});

app.get('/verify/status/:wallet', (req, res) => {
  const { wallet } = req.params;
  const verification = REGISTRY.verifiedWallets.get(wallet);
  
  res.json(verification ? { verified: true, ...verification } : {
    verified: false,
    paymentAddress: CONFIG.PAYMENT_ADDRESS,
    requiredAmount: `$${CONFIG.VERIFICATION_AMOUNT} USDC`
  });
});

// =============================================================================
// SERVICES ROUTES
// =============================================================================

app.get('/services', async (req, res) => {
  const { category, limit = 50, offset = 0 } = req.query;
  
  if (REGISTRY.services.size === 0) {
    await syncX402Services();
  }
  
  let services = Array.from(REGISTRY.services.values());
  
  if (category) {
    services = services.filter(s => s.category === category);
  }
  
  const total = services.length;
  services = services.slice(Number(offset), Number(offset) + Number(limit));
  
  res.json({
    total,
    services: services.map(s => ({
      id: s.id,
      source: s.source,
      name: s.name,
      resource: s.resource,
      description: s.description,
      category: s.category,
      pricing: s.pricing,
      discoveredAt: s.discoveredAt
    }))
  });
});

app.post('/sync', async (req, res) => {
  const result = await syncX402Services();
  res.json({ success: true, ...result, lastSync: REGISTRY.lastSync });
});

app.get('/stats', (req, res) => {
  const agents = Array.from(REGISTRY.agents.values());
  res.json({
    agents: agents.length,
    services: REGISTRY.services.size,
    verifiedWallets: REGISTRY.verifiedWallets.size,
    avgScore: agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.scores.fairscore, 0) / agents.length) : 0,
    lastSync: REGISTRY.lastSync
  });
});

// =============================================================================
// START
// =============================================================================

const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`FairScale Registry API v6.2 running on port ${PORT}`);
  syncX402Services();
});
