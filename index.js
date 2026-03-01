import express from 'express';
import cors from 'cors';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
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
// LOGARITHMIC SCORING - Makes 100 very difficult to achieve
// =============================================================================

function logScale(value, max, curve = 2) {
  // Logarithmic scaling: easy to get to 50, hard to get to 80, very hard to get to 100
  // curve controls steepness (higher = harder to reach top)
  const normalized = Math.min(value / max, 1);
  const scaled = Math.pow(normalized, 1 / curve) * 100;
  return Math.min(Math.round(scaled), 99); // Cap at 99, 100 requires exceptional metrics
}

function logScaleInverse(value, max, curve = 2) {
  // For percentiles that are already 0-1
  const scaled = Math.pow(value, 1 / curve) * 100;
  return Math.min(Math.round(scaled), 99);
}

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),
  services: new Map(),        // x402 services registered by agents
  verifiedWallets: new Map(),
  challenges: new Map(),      // For signature verification
  lastSync: null
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
// SIGNATURE VERIFICATION
// =============================================================================

function generateChallenge(wallet) {
  const challenge = `fairscale:${wallet}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  REGISTRY.challenges.set(wallet, { challenge, expires: Date.now() + 300000 }); // 5 min
  return challenge;
}

function verifySignature(wallet, signature, message) {
  try {
    const publicKey = bs58.decode(wallet);
    const signatureBytes = bs58.decode(signature);
    const messageBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
  } catch (e) {
    return false;
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
// AGENT SCORE CALCULATIONS - LOGARITHMIC SCALING
// =============================================================================

function calculateAgentFeatures(fairscaleData) {
  const f = fairscaleData?.features || {};
  
  // Raw values
  const walletAgeDays = f.wallet_age_days || 0;
  const activeDays = f.active_days || 0;
  const txCount = f.tx_count || 0;
  const platformDiversity = f.platform_diversity || 0;
  const convictionRatio = f.conviction_ratio || 0;
  const medianHoldDays = f.median_hold_days || 0;
  const noInstantDumps = f.no_instant_dumps || 0;
  const majorPercentile = f.major_percentile_score || 0;
  const stablePercentile = f.stable_percentile_score || 0;
  const lstPercentile = f.lst_percentile_score || 0;
  const solPercentile = f.native_sol_percentile || 0;
  
  // ==========================================================================
  // LONGEVITY - "How consistently active is this wallet?"
  // Threshold: 60 days with 50%+ activity ratio for top scores
  // ==========================================================================
  
  const ageScore = logScale(walletAgeDays, 60, 2.5);
  const activityRatio = walletAgeDays > 0 ? activeDays / walletAgeDays : 0;
  const activityScore = logScaleInverse(activityRatio, 1, 2);
  const longevity = Math.round((ageScore * 0.4) + (activityScore * 0.6));
  
  // ==========================================================================
  // EXPERIENCE - "How much has this wallet done on-chain?"
  // Threshold: 500 txs across 10 protocols for top scores
  // ==========================================================================
  
  const txScore = logScale(txCount, 500, 3);
  const diversityScore = logScale(platformDiversity, 10, 2);
  const experience = Math.round((txScore * 0.6) + (diversityScore * 0.4));
  
  // ==========================================================================
  // STABILITY - "Does this wallet hold or dump?"
  // Uses conviction ratio, hold time, and dump behavior
  // ==========================================================================
  
  const convScore = logScaleInverse(convictionRatio, 1, 2);
  const holdScore = logScale(medianHoldDays, 30, 2.5);
  const dumpScore = logScaleInverse(noInstantDumps, 1, 1.5);
  const stability = Math.round((convScore * 0.35) + (holdScore * 0.35) + (dumpScore * 0.3));
  
  // ==========================================================================
  // CAPITAL - "What's the wallet's holdings percentile?"
  // Percentiles are already relative, apply log curve
  // ==========================================================================
  
  const majorScore = logScaleInverse(majorPercentile, 1, 2.5);
  const stableScore = logScaleInverse(stablePercentile, 1, 2.5);
  const lstScore = logScaleInverse(lstPercentile, 1, 2.5);
  const solScore = logScaleInverse(solPercentile, 1, 2.5);
  const capital = Math.round((majorScore * 0.3) + (stableScore * 0.3) + (lstScore * 0.2) + (solScore * 0.2));
  
  // ==========================================================================
  // FALLBACK
  // ==========================================================================
  
  const allZero = walletAgeDays === 0 && txCount === 0 && activeDays === 0;
  
  if (allZero && fairscaleData) {
    const fsBase = fairscaleData.fairscore_base || fairscaleData.fairscore || 0;
    const scaled = logScale(fsBase, 100, 1.5);
    return {
      longevity: Math.round(scaled * 0.8),
      experience: Math.round(scaled * 0.9),
      stability: Math.round(scaled * 0.85),
      capital: Math.round(scaled * 0.75),
      _fallback: true
    };
  }
  
  // Bonus for exceptional metrics - only way to hit 100
  const bonus = (walletAgeDays > 180 && txCount > 1000 && activityRatio > 0.7) ? 1 : 0;
  
  return {
    longevity: Math.min(longevity + bonus, 100),
    experience: Math.min(experience + bonus, 100),
    stability: Math.min(stability + bonus, 100),
    capital: Math.min(capital + bonus, 100),
    _fallback: false
  };
}

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
  // FairScale base (45%)
  const fsBase = fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0;
  const fsScore = logScale(fsBase, 100, 1.5) * 0.45;
  
  // Features (35%)
  const featureAvg = (features.longevity + features.experience + features.stability + features.capital) / 4;
  const featureScore = featureAvg * 0.35;
  
  // SAID (10%)
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
// FEATURE DESCRIPTIONS - Technical but readable
// =============================================================================

function getFeatureDescription(feature, value) {
  const descriptions = {
    longevity: {
      high: 'Active 50%+ of wallet lifetime, consistent on-chain presence',
      mid: 'Regular activity pattern, some gaps in usage',
      low: 'Sporadic activity or recently created wallet'
    },
    experience: {
      high: '500+ transactions across 8+ protocols',
      mid: '100-500 transactions, uses multiple protocols',
      low: 'Under 100 transactions, limited protocol usage'
    },
    stability: {
      high: 'Holds positions 14+ days, rarely sells within 24h of receiving',
      mid: 'Mixed behavior, some quick sells but also holds',
      low: 'Frequently sells within hours of receiving tokens'
    },
    capital: {
      high: 'Top 20% holdings in major tokens and stables',
      mid: 'Average holdings relative to network',
      low: 'Below average token holdings'
    }
  };
  
  const tier = value >= 65 ? 'high' : value >= 35 ? 'mid' : 'low';
  return descriptions[feature]?.[tier] || '';
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
      longevity: features.longevity,
      experience: features.experience,
      stability: features.stability,
      capital: features.capital
    },
    descriptions: {
      longevity: getFeatureDescription('longevity', features.longevity),
      experience: getFeatureDescription('experience', features.experience),
      stability: getFeatureDescription('stability', features.stability),
      capital: getFeatureDescription('capital', features.capital)
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
    version: '9.0.0',
    endpoints: {
      'GET /score': 'Get agent score',
      'POST /register': 'Register agent (requires signature)',
      'POST /verify': 'Verify payment',
      'GET /challenge': 'Get signing challenge',
      'POST /service': 'Register x402 service (requires signature)',
      'GET /services': 'List services',
      'GET /directory': 'List agents'
    }
  });
});

// Get signing challenge
app.get('/challenge', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  const challenge = generateChallenge(wallet);
  res.json({ challenge, expiresIn: 300 });
});

// Get agent score
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

// Register agent (requires signature)
app.post('/register', async (req, res) => {
  const { wallet, signature, challenge, name, description, website, mcp } = req.body;
  
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  // If signature provided, verify it
  if (signature && challenge) {
    const stored = REGISTRY.challenges.get(wallet);
    if (!stored || stored.challenge !== challenge || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }
    if (!verifySignature(wallet, signature, challenge)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    REGISTRY.challenges.delete(wallet);
  }
  
  REGISTRY.registeredAgents.set(wallet, {
    wallet, name, description, website, mcp,
    registeredAt: new Date().toISOString(),
    verified: !!signature
  });
  
  REGISTRY.agents.delete(wallet);
  const agent = await getOrCreateAgent(wallet);
  
  res.json({
    success: true,
    message: signature ? 'Registered with signature verification' : 'Registered (unverified)',
    agent: agent ? {
      wallet,
      name: agent.name,
      agent_fairscore: agent.scores.agent_fairscore
    } : null
  });
});

// Register x402 service (requires signature)
app.post('/service', async (req, res) => {
  const { wallet, signature, challenge, url, name, description, price, category } = req.body;
  
  if (!wallet || !url || !name) {
    return res.status(400).json({ error: 'Missing wallet, url, or name' });
  }
  
  // Require signature for service registration
  if (!signature || !challenge) {
    return res.status(400).json({ error: 'Signature required. Get challenge from /challenge first.' });
  }
  
  const stored = REGISTRY.challenges.get(wallet);
  if (!stored || stored.challenge !== challenge || Date.now() > stored.expires) {
    return res.status(400).json({ error: 'Invalid or expired challenge' });
  }
  if (!verifySignature(wallet, signature, challenge)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  REGISTRY.challenges.delete(wallet);
  
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
  
  res.json({
    success: true,
    serviceId,
    message: 'Service registered'
  });
});

// Verify payment
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

// List services
app.get('/services', (req, res) => {
  const services = Array.from(REGISTRY.services.values());
  res.json({ total: services.length, network: 'solana', services });
});

// Directory
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

// Stats
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
  console.log(`FairScale Registry v9 on port ${CONFIG.PORT}`);
});
