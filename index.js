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
  PORT: process.env.PORT || 8080
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),
  services: new Map(),
  verifiedWallets: new Map()
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
// SCORING - LOGARITHMIC SCALE (hard to reach 100)
// =============================================================================

function logScale(value, max, curve = 2) {
  const normalized = Math.min(value / max, 1);
  return Math.min(Math.round(Math.pow(normalized, 1 / curve) * 100), 99);
}

// =============================================================================
// AGENT METRICS - TRUST-FOCUSED
// 
// What makes you trust an agent?
// 1. ACTIVITY - Are they consistently doing things on-chain?
// 2. DIVERSITY - Do they operate across multiple protocols?
// 3. RELIABILITY - Are their patterns predictable and stable?
// 4. TRACK RECORD - How long have they been active?
// =============================================================================

function calculateAgentFeatures(fairscaleData) {
  const f = fairscaleData?.features || {};
  
  // Raw FairScale features
  const txCount = f.tx_count || 0;
  const activeDays = f.active_days || 0;
  const walletAgeDays = f.wallet_age_days || 0;
  const platformDiversity = f.platform_diversity || 0;
  const medianGapHours = f.median_gap_hours || 0;
  const tempoCV = f.tempo_cv || 0;
  const burstRatio = f.burst_ratio || 0;
  const convictionRatio = f.conviction_ratio || 0;
  const noInstantDumps = f.no_instant_dumps || 0;
  
  // ==========================================================================
  // ACTIVITY - "Is this agent consistently transacting?"
  // High tx count + high activity ratio = actively maintained agent
  // ==========================================================================
  
  const txScore = logScale(txCount, 300, 2.5);
  const activityRatio = walletAgeDays > 0 ? activeDays / walletAgeDays : 0;
  const consistencyScore = logScale(activityRatio * 100, 60, 2); // 60% active = max
  
  // Penalize erratic burst patterns (suggests bot spam, not real usage)
  const burstPenalty = burstRatio > 0.8 ? 0.6 : burstRatio > 0.5 ? 0.8 : 1;
  
  const activity = Math.round(((txScore * 0.5) + (consistencyScore * 0.5)) * burstPenalty);
  
  // ==========================================================================
  // DIVERSITY - "Does this agent integrate across the ecosystem?"
  // More protocols = more useful, more battle-tested
  // ==========================================================================
  
  const protocolScore = logScale(platformDiversity, 8, 2);
  const recentBonus = activityRatio > 0.3 ? 8 : 0; // Bonus if recently active
  
  const diversity = Math.min(protocolScore + recentBonus, 99);
  
  // ==========================================================================
  // RELIABILITY - "Can you predict this agent's behavior?"
  // Consistent timing + follows through on transactions + no dumps
  // ==========================================================================
  
  // Tempo CV: lower = more consistent timing (good)
  const tempoScore = tempoCV > 0 ? Math.min(logScale(1 / tempoCV, 1.5, 2), 99) : 50;
  
  // No instant dumps = follows through, doesn't rug
  const followThrough = logScale(noInstantDumps * 100, 100, 1.5);
  
  // Conviction = holds positions, doesn't flip constantly
  const holdingScore = logScale(convictionRatio * 100, 80, 2);
  
  const reliability = Math.round((tempoScore * 0.25) + (followThrough * 0.4) + (holdingScore * 0.35));
  
  // ==========================================================================
  // TRACK RECORD - "How long has this agent been operating?"
  // Age alone isn't enough - needs sustained activity
  // ==========================================================================
  
  const ageScore = logScale(walletAgeDays, 90, 2.5);
  const sustainedActivity = activityRatio > 0.2 ? 1.15 : 0.85; // Multiplier
  
  const trackRecord = Math.min(Math.round(ageScore * sustainedActivity), 99);
  
  // ==========================================================================
  // FALLBACK - When FairScale features are empty
  // ==========================================================================
  
  const allZero = walletAgeDays === 0 && txCount === 0 && activeDays === 0;
  
  if (allZero && fairscaleData) {
    const fsBase = fairscaleData.fairscore || fairscaleData.fairscore_base || 0;
    return {
      activity: Math.round(fsBase * 0.80),
      diversity: Math.round(fsBase * 0.70),
      reliability: Math.round(fsBase * 0.75),
      trackRecord: Math.round(fsBase * 0.65),
      _fallback: true
    };
  }
  
  return {
    activity: Math.min(Math.max(activity, 0), 99),
    diversity: Math.min(Math.max(diversity, 0), 99),
    reliability: Math.min(Math.max(reliability, 0), 99),
    trackRecord: Math.min(Math.max(trackRecord, 0), 99),
    _fallback: false
  };
}

// =============================================================================
// FEATURE DESCRIPTIONS - Actionable trust signals
// =============================================================================

function getFeatureDescription(feature, value) {
  const descriptions = {
    activity: {
      high: '200+ transactions, active most days',
      mid: 'Moderate transaction volume',
      low: 'Limited on-chain activity'
    },
    diversity: {
      high: 'Integrated with 6+ protocols',
      mid: 'Uses 3-5 different protocols',
      low: 'Single protocol usage'
    },
    reliability: {
      high: 'Consistent patterns, completes transactions',
      mid: 'Some variance in behavior',
      low: 'Unpredictable or incomplete transactions'
    },
    trackRecord: {
      high: '60+ days of sustained activity',
      mid: '30-60 days active',
      low: 'New or sporadic presence'
    }
  };
  
  const tier = value >= 55 ? 'high' : value >= 28 ? 'mid' : 'low';
  return descriptions[feature]?.[tier] || '';
}

// =============================================================================
// AGENT FAIRSCORE CALCULATION
// =============================================================================

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
  // FairScale base score (40%)
  const fsBase = fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0;
  const fsScore = logScale(fsBase, 100, 1.5) * 0.40;
  
  // Our trust metrics (40%)
  const featureScore = (
    (features.activity * 0.30) +
    (features.diversity * 0.20) +
    (features.reliability * 0.30) +
    (features.trackRecord * 0.20)
  ) * 0.40;
  
  // SAID reputation (10%)
  const saidScore = (saidData?.reputation?.score || 0) * 0.10;
  
  // Bonuses (up to 10%)
  let bonuses = 0;
  if (saidData?.verified) bonuses += 2;
  if (saidData?.reputation?.trustTier === 'high') bonuses += 2;
  bonuses += Math.min((saidData?.reputation?.feedbackCount || 0), 4);
  if (REGISTRY.registeredAgents.has(wallet)) bonuses += 1;
  if (REGISTRY.verifiedWallets.has(wallet)) bonuses += 8;
  
  const total = fsScore + featureScore + saidScore + Math.min(bonuses, 10);
  return Math.min(Math.round(total), 100);
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
  const agentFairScore = calculateAgentFairScore(fairscaleData, features, saidData, wallet);
  const regData = REGISTRY.registeredAgents.get(wallet);
  
  const agent = {
    wallet,
    name: regData?.name || saidData?.identity?.name || null,
    description: regData?.description || saidData?.identity?.description || null,
    website: regData?.website || saidData?.identity?.website || null,
    mcp: regData?.mcp || saidData?.endpoints?.mcp || null,
    scores: {
      agent_fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: saidData?.reputation?.feedbackCount || 0
    },
    features: {
      activity: features.activity,
      diversity: features.diversity,
      reliability: features.reliability,
      trackRecord: features.trackRecord
    },
    descriptions: {
      activity: getFeatureDescription('activity', features.activity),
      diversity: getFeatureDescription('diversity', features.diversity),
      reliability: getFeatureDescription('reliability', features.reliability),
      trackRecord: getFeatureDescription('trackRecord', features.trackRecord)
    },
    isRegistered: REGISTRY.registeredAgents.has(wallet),
    isVerified: REGISTRY.verifiedWallets.has(wallet),
    services: Array.from(REGISTRY.services.values()).filter(s => s.wallet === wallet),
    lastUpdated: new Date().toISOString()
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
    version: '9.1.0',
    endpoints: {
      'GET /score': 'Get agent score',
      'POST /register': 'Register agent',
      'POST /verify': 'Verify payment',
      'POST /service': 'Register x402 service',
      'GET /services': 'List services',
      'GET /directory': 'List agents'
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
  const { wallet, name, description, website, mcp } = req.body;
  
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  REGISTRY.registeredAgents.set(wallet, {
    wallet, name, description, website, mcp,
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
  const agents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered)
    .sort((a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore)
    .slice(0, 100)
    .map(a => ({
      wallet: a.wallet,
      name: a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      agent_fairscore: a.scores.agent_fairscore,
      isVerified: a.isVerified,
      services: a.services.length
    }));
  
  res.json({ total: agents.length, agents });
});

app.get('/stats', (req, res) => {
  res.json({
    agents: REGISTRY.agents.size,
    registered: REGISTRY.registeredAgents.size,
    verified: REGISTRY.verifiedWallets.size,
    services: REGISTRY.services.size
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Registry v9.1 on port ${CONFIG.PORT}`);
});
