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
  X402_COMMUNITY_API: 'https://x402-discovery-api.onrender.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  HELIUS_RPC: 'https://mainnet.helius-rpc.com',
  PAYMENT_ADDRESS: 'fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  VERIFICATION_AMOUNT: 5,
  PORT: process.env.PORT || 8080
};

// =============================================================================
// AGENT SCORING THRESHOLDS
// Optimized for AI agents - shorter timeframes, higher activity expectations
// 
// PERCENTILE FIELDS (0-1 scale, already normalized by FairScale):
//   - major_percentile_score
//   - stable_percentile_score
//   - lst_percentile_score
//   - native_sol_percentile
//
// RAW FIELDS (absolute values we normalize ourselves):
//   - wallet_age_days
//   - active_days
//   - tx_count
//   - platform_diversity
//   - median_hold_days
//   - conviction_ratio (0-1)
//   - no_instant_dumps (0-1)
// =============================================================================

const AGENT_THRESHOLDS = {
  // Longevity: 30 days = max score (agents are new, activity matters more)
  WALLET_AGE_MAX_DAYS: 30,
  
  // Experience: Agents transact heavily
  TX_COUNT_MAX: 100,           // 100 txs = 100%
  PLATFORM_DIVERSITY_MAX: 5,   // 5 protocols = 100%
  
  // Conviction: Agents may trade more, 7 days holding is solid
  MEDIAN_HOLD_DAYS_MAX: 7,
};

// =============================================================================
// IN-MEMORY REGISTRY
// =============================================================================

const REGISTRY = {
  agents: new Map(),
  registeredAgents: new Map(),  // Agents who registered themselves
  services: new Map(),
  verifiedWallets: new Map(),
  lastSync: null
};

// =============================================================================
// BADGE DEFINITIONS
// =============================================================================

const BADGE_DEFINITIONS = {
  established: { label: 'Established', description: 'Active for 30+ days' },
  active: { label: 'Active', description: 'High transaction frequency' },
  committed: { label: 'Committed', description: 'Consistent holding behavior' },
  capitalised: { label: 'Capitalised', description: 'Above-average holdings' },
  diverse: { label: 'Diverse', description: 'Multi-protocol usage' },
  experienced: { label: 'Experienced', description: '100+ transactions' },
  diamond_hands: { label: 'Diamond Hands', description: 'Long-term holder' },
  attested: { label: 'Attested', description: 'Has attestations on SAID' },
  trusted_by_many: { label: 'Trusted', description: '5+ attestations' },
  said_verified: { label: 'SAID Verified', description: 'Verified identity' },
  said_trusted: { label: 'High Trust', description: 'High trust tier' },
  mcp_available: { label: 'MCP', description: 'Has MCP endpoint' },
  registered: { label: 'Registered', description: 'Self-registered agent' },
  fairscale_verified: { label: 'FS Verified', description: 'Paid verification' }
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

async function getX402SolanaServices() {
  try {
    const response = await fetch(`${CONFIG.X402_COMMUNITY_API}/services`, {
      headers: { 'accept': 'application/json' }
    });
    if (!response.ok) return [];
    const services = await response.json();
    // Filter to Solana-only services
    return (services || []).filter(s => {
      const network = (s.network || s.pricing?.network || '').toLowerCase();
      return network.includes('solana') || network.includes('sol') || network === '';
    });
  } catch (e) {
    return [];
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
// AGENT SCORE CALCULATIONS
// =============================================================================

function calculateAgentFeatures(fairscaleData) {
  const f = fairscaleData?.features || {};
  const T = AGENT_THRESHOLDS;
  
  // ==========================================================================
  // LONGEVITY
  // - wallet_age_days: RAW value, we normalize to 30 days = 100%
  // - active_days: RAW value
  // - Activity RATIO is key for agents (consistency > raw age)
  // ==========================================================================
  
  const walletAgeDays = f.wallet_age_days || 0;
  const activeDays = f.active_days || 0;
  
  // Age score: 30 days = 100%
  const ageScore = Math.min((walletAgeDays / T.WALLET_AGE_MAX_DAYS) * 100, 100);
  
  // Activity ratio: what % of days were they active?
  // For agents, being active 50% of days is excellent
  const activityRatio = walletAgeDays > 0 
    ? Math.min((activeDays / walletAgeDays) * 200, 100) // 50% active = 100%
    : 0;
  
  // Longevity: 30% age, 70% activity ratio (agents need consistency, not age)
  const longevity = Math.round((ageScore * 0.3) + (activityRatio * 0.7));
  
  // ==========================================================================
  // EXPERIENCE
  // - tx_count: RAW value, normalize to 100 txs = 100%
  // - platform_diversity: RAW value, 5 protocols = 100%
  // ==========================================================================
  
  const txCount = f.tx_count || 0;
  const platformDiversity = f.platform_diversity || 0;
  
  const txScore = Math.min((txCount / T.TX_COUNT_MAX) * 100, 100);
  const diversityScore = Math.min((platformDiversity / T.PLATFORM_DIVERSITY_MAX) * 100, 100);
  
  // Experience: 60% transactions, 40% diversity
  const experience = Math.round((txScore * 0.6) + (diversityScore * 0.4));
  
  // ==========================================================================
  // CONVICTION
  // - conviction_ratio: Already 0-1, multiply by 100
  // - median_hold_days: RAW, 7 days = 100% for agents
  // - no_instant_dumps: Already 0-1, multiply by 100
  // ==========================================================================
  
  const convictionRatio = (f.conviction_ratio || 0) * 100;
  const medianHoldDays = f.median_hold_days || 0;
  const noInstantDumps = (f.no_instant_dumps || 0) * 100;
  
  const holdScore = Math.min((medianHoldDays / T.MEDIAN_HOLD_DAYS_MAX) * 100, 100);
  
  // Conviction: 40% ratio, 30% hold time, 30% no dumps
  const conviction = Math.round((convictionRatio * 0.4) + (holdScore * 0.3) + (noInstantDumps * 0.3));
  
  // ==========================================================================
  // CAPITAL
  // - These are PERCENTILE scores (0-1), already normalized by FairScale
  // - Just multiply by 100 to get 0-100 scale
  // ==========================================================================
  
  const majorPercentile = (f.major_percentile_score || 0) * 100;
  const stablePercentile = (f.stable_percentile_score || 0) * 100;
  const lstPercentile = (f.lst_percentile_score || 0) * 100;
  const solPercentile = (f.native_sol_percentile || 0) * 100;
  
  // Capital: weighted average of percentiles
  const capital = Math.round(
    (majorPercentile * 0.3) + 
    (stablePercentile * 0.3) + 
    (lstPercentile * 0.2) + 
    (solPercentile * 0.2)
  );
  
  // ==========================================================================
  // FALLBACK: If features are all 0 but FairScale gave a score
  // ==========================================================================
  
  const allZero = walletAgeDays === 0 && txCount === 0 && activeDays === 0;
  
  if (allZero && fairscaleData) {
    const fsBase = fairscaleData.fairscore_base || fairscaleData.fairscore || 0;
    const fsTier = fairscaleData.tier;
    const tierBonus = fsTier === 'gold' ? 15 : fsTier === 'silver' ? 8 : 0;
    
    // Derive from their score with variance
    return {
      longevity: Math.min(Math.round(fsBase * 0.85 + tierBonus + Math.random() * 5), 100),
      experience: Math.min(Math.round(fsBase * 0.95 + tierBonus + Math.random() * 5), 100),
      conviction: Math.min(Math.round(fsBase * 0.90 + tierBonus + Math.random() * 5), 100),
      capital: Math.min(Math.round(fsBase * 0.80 + tierBonus + Math.random() * 5), 100),
      _fallback: true
    };
  }
  
  return {
    longevity: Math.min(Math.max(longevity, 0), 100),
    experience: Math.min(Math.max(experience, 0), 100),
    conviction: Math.min(Math.max(conviction, 0), 100),
    capital: Math.min(Math.max(capital, 0), 100),
    _fallback: false
  };
}

function calculateBadges(fairscaleData, saidData, wallet) {
  const f = fairscaleData?.features || {};
  const badges = [];
  
  // Pass through FairScale badges
  for (const b of (fairscaleData?.badges || [])) {
    if (b.id && !badges.find(x => x.id === b.id)) {
      badges.push({ 
        id: b.id, 
        label: BADGE_DEFINITIONS[b.id]?.label || b.label || b.id, 
        description: b.description || '',
        tier: b.tier 
      });
    }
  }
  
  // Feature-based badges (agent thresholds)
  if ((f.wallet_age_days || 0) >= 30 && !badges.find(b => b.id === 'established')) {
    badges.push({ ...BADGE_DEFINITIONS.established, id: 'established' });
  }
  if ((f.tx_count || 0) >= 100 && !badges.find(b => b.id === 'experienced')) {
    badges.push({ ...BADGE_DEFINITIONS.experienced, id: 'experienced' });
  }
  if ((f.active_days || 0) >= 14 && !badges.find(b => b.id === 'active')) {
    badges.push({ ...BADGE_DEFINITIONS.active, id: 'active' });
  }
  if ((f.platform_diversity || 0) >= 3 && !badges.find(b => b.id === 'diverse')) {
    badges.push({ ...BADGE_DEFINITIONS.diverse, id: 'diverse' });
  }
  if ((f.conviction_ratio || 0) >= 0.4 && !badges.find(b => b.id === 'committed')) {
    badges.push({ ...BADGE_DEFINITIONS.committed, id: 'committed' });
  }
  if (((f.major_percentile_score || 0) >= 0.3 || (f.stable_percentile_score || 0) >= 0.3) && !badges.find(b => b.id === 'capitalised')) {
    badges.push({ ...BADGE_DEFINITIONS.capitalised, id: 'capitalised' });
  }
  
  // SAID badges
  const feedbackCount = saidData?.reputation?.feedbackCount || 0;
  if (feedbackCount >= 1) badges.push({ ...BADGE_DEFINITIONS.attested, id: 'attested' });
  if (feedbackCount >= 5) badges.push({ ...BADGE_DEFINITIONS.trusted_by_many, id: 'trusted_by_many' });
  if (saidData?.verified) badges.push({ ...BADGE_DEFINITIONS.said_verified, id: 'said_verified' });
  if (saidData?.reputation?.trustTier === 'high') badges.push({ ...BADGE_DEFINITIONS.said_trusted, id: 'said_trusted' });
  if (saidData?.endpoints?.mcp) badges.push({ ...BADGE_DEFINITIONS.mcp_available, id: 'mcp_available' });
  
  // Registry badges
  if (REGISTRY.registeredAgents.has(wallet)) {
    badges.push({ ...BADGE_DEFINITIONS.registered, id: 'registered' });
  }
  if (REGISTRY.verifiedWallets.has(wallet)) {
    badges.push({ ...BADGE_DEFINITIONS.fairscale_verified, id: 'fairscale_verified' });
  }
  
  return badges;
}

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
  let score = 0;
  
  // 1. FairScale base (40%)
  const fsScore = fairscaleData?.fairscore || fairscaleData?.fairscore_base || 0;
  score += fsScore * 0.40;
  
  // 2. Agent features (35%)
  const featureAvg = (features.longevity + features.experience + features.conviction + features.capital) / 4;
  score += featureAvg * 0.35;
  
  // 3. SAID (15%)
  const saidScore = saidData?.reputation?.score || 0;
  score += saidScore * 0.15;
  
  // 4. Bonuses (up to +15)
  let bonuses = 0;
  
  if (saidData?.verified) bonuses += 3;
  if (saidData?.reputation?.trustTier === 'high') bonuses += 3;
  bonuses += Math.min((saidData?.reputation?.feedbackCount || 0) * 1.5, 6);
  
  if (fairscaleData?.tier === 'gold') bonuses += 2;
  else if (fairscaleData?.tier === 'silver') bonuses += 1;
  
  if (REGISTRY.registeredAgents.has(wallet)) bonuses += 2;
  if (REGISTRY.verifiedWallets.has(wallet)) bonuses += 10;
  
  score += Math.min(bonuses, 15);
  
  return Math.min(Math.round(score), 100);
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
  const badges = calculateBadges(fairscaleData, saidData, wallet);
  const agentFairScore = calculateAgentFairScore(fairscaleData, features, saidData, wallet);
  
  // Get registration data if exists
  const regData = REGISTRY.registeredAgents.get(wallet);
  
  const agent = {
    wallet,
    name: regData?.name || saidData?.identity?.name || null,
    description: regData?.description || saidData?.identity?.description || null,
    social: {
      twitter: saidData?.identity?.twitter || null,
      website: regData?.website || saidData?.identity?.website || null
    },
    endpoints: {
      mcp: regData?.mcp || saidData?.endpoints?.mcp || null,
      a2a: saidData?.endpoints?.a2a || null
    },
    skills: regData?.skills || saidData?.skills || [],
    scores: {
      agent_fairscore: agentFairScore,
      fairscore_base: Math.round(fairscaleData?.fairscore_base || fairscaleData?.fairscore || 0),
      said_score: saidData?.reputation?.score || null,
      said_trust_tier: saidData?.reputation?.trustTier || null,
      attestations: saidData?.reputation?.feedbackCount || 0,
      tier: fairscaleData?.tier || null
    },
    features: {
      longevity: features.longevity,
      experience: features.experience,
      conviction: features.conviction,
      capital: features.capital
    },
    badges,
    sources: [],
    isRegistered: REGISTRY.registeredAgents.has(wallet),
    isVerified: REGISTRY.verifiedWallets.has(wallet),
    lastUpdated: new Date().toISOString()
  };
  
  if (fairscaleData) agent.sources.push('fairscale');
  if (saidData?.registered) agent.sources.push('said');
  if (regData) agent.sources.push('registry');
  
  REGISTRY.agents.set(wallet, agent);
  return agent;
}

// =============================================================================
// SERVICES SYNC (Solana only)
// =============================================================================

async function syncServices() {
  const services = await getX402SolanaServices();
  let added = 0;
  
  for (const svc of services) {
    const id = `sol_${Math.random().toString(36).substr(2, 9)}`;
    const resource = svc.url || svc.resource || svc.endpoint;
    
    if (!resource || Array.from(REGISTRY.services.values()).find(s => s.resource === resource)) continue;
    
    REGISTRY.services.set(id, {
      id,
      source: 'x402_solana',
      resource,
      name: svc.name || 'Solana Service',
      description: svc.description || 'x402 Solana endpoint',
      category: svc.category || 'utility',
      pricing: {
        price: svc.price_usd ? `$${svc.price_usd}` : svc.price || 'Contact',
        raw: svc.price_usd || svc.price
      },
      network: 'solana',
      discoveredAt: new Date().toISOString()
    });
    added++;
  }
  
  REGISTRY.lastSync = new Date().toISOString();
  return { added, total: REGISTRY.services.size };
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '8.0.0',
    description: 'Agent reputation scoring for Solana',
    endpoints: {
      'GET /score?wallet=': 'Get agent reputation score',
      'POST /register': 'Register your agent',
      'POST /verify': 'Verify payment for score boost',
      'GET /directory': 'List registered agents',
      'GET /services': 'Solana x402 services'
    }
  });
});

// Check agent score
app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  const agent = await getOrCreateAgent(wallet);
  if (!agent) return res.status(404).json({ error: 'Could not fetch data', wallet });
  
  res.json({
    wallet,
    name: agent.name || `Agent ${wallet.slice(0, 8)}...`,
    description: agent.description,
    agent_fairscore: agent.scores.agent_fairscore,
    fairscore_base: agent.scores.fairscore_base,
    tier: agent.scores.tier,
    features: agent.features,
    badges: agent.badges,
    said: {
      registered: agent.sources.includes('said'),
      verified: agent.badges.some(b => b.id === 'said_verified'),
      score: agent.scores.said_score,
      trustTier: agent.scores.said_trust_tier,
      feedbackCount: agent.scores.attestations
    },
    social: agent.social,
    endpoints: agent.endpoints,
    skills: agent.skills,
    isRegistered: agent.isRegistered,
    isVerified: agent.isVerified,
    sources: agent.sources
  });
});

// Register agent
app.post('/register', async (req, res) => {
  const { wallet, name, description, website, mcp, skills } = req.body;
  
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  
  // Store registration
  REGISTRY.registeredAgents.set(wallet, {
    wallet,
    name: name || null,
    description: description || null,
    website: website || null,
    mcp: mcp || null,
    skills: skills || [],
    registeredAt: new Date().toISOString()
  });
  
  // Clear cache to recalculate
  REGISTRY.agents.delete(wallet);
  
  // Return updated score
  const agent = await getOrCreateAgent(wallet);
  
  res.json({
    success: true,
    message: 'Agent registered! +2 score bonus applied.',
    agent: agent ? {
      wallet,
      name: agent.name,
      agent_fairscore: agent.scores.agent_fairscore,
      badges: agent.badges
    } : null
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
    return res.json({ success: true, message: '+10 score boost applied', txSignature: result.txSignature });
  }
  
  res.status(400).json({ success: false, error: result.error, paymentAddress: CONFIG.PAYMENT_ADDRESS });
});

// Directory of registered agents
app.get('/directory', (req, res) => {
  const agents = Array.from(REGISTRY.agents.values())
    .filter(a => a.isRegistered || a.sources.includes('said'))
    .sort((a, b) => b.scores.agent_fairscore - a.scores.agent_fairscore)
    .slice(0, 100);
  
  res.json({
    total: agents.length,
    agents: agents.map(a => ({
      wallet: a.wallet,
      name: a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      agent_fairscore: a.scores.agent_fairscore,
      badges: a.badges.map(b => b.id),
      isVerified: a.isVerified
    }))
  });
});

// Solana services
app.get('/services', async (req, res) => {
  if (REGISTRY.services.size === 0) await syncServices();
  
  const services = Array.from(REGISTRY.services.values());
  res.json({ total: services.length, network: 'solana', services });
});

app.post('/sync', async (req, res) => {
  const result = await syncServices();
  res.json({ success: true, ...result });
});

app.get('/stats', (req, res) => {
  const agents = Array.from(REGISTRY.agents.values());
  res.json({
    totalAgents: agents.length,
    registeredAgents: REGISTRY.registeredAgents.size,
    verifiedAgents: REGISTRY.verifiedWallets.size,
    services: REGISTRY.services.size,
    avgScore: agents.length ? Math.round(agents.reduce((s, a) => s + a.scores.agent_fairscore, 0) / agents.length) : 0
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`FairScale Agent Registry v8 on port ${CONFIG.PORT}`);
  syncServices();
});
