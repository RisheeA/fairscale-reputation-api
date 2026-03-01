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
  PORT: process.env.PORT || 8080
};

// =============================================================================
// IN-MEMORY REGISTRY (Replace with DB in production)
// =============================================================================

const REGISTRY = {
  agents: new Map(),      // wallet -> AgentRecord
  skills: new Map(),      // skillId -> SkillRecord
  services: new Map(),    // serviceId -> ServiceRecord
  lastSync: null
};

// =============================================================================
// BADGE DEFINITIONS
// =============================================================================

const BADGE_DEFINITIONS = {
  established: { label: 'Established', description: 'Wallet active for extended period with consistent usage' },
  committed: { label: 'Committed', description: 'Holds positions long-term, rarely panic sells' },
  capitalised: { label: 'Capitalised', description: 'Significant token holdings relative to network' },
  diverse: { label: 'Diverse', description: 'Interacts across multiple protocols and platforms' },
  experienced: { label: 'Experienced', description: 'High transaction volume demonstrating active usage' },
  holder: { label: 'Holder', description: 'Maintains positions for extended periods' },
  net_positive: { label: 'Net Positive', description: 'Accumulating assets, not extracting value' },
  staker: { label: 'Staker', description: 'Actively participates in network staking' },
  social: { label: 'Social', description: 'Verified social presence linked to wallet' },
  attested: { label: 'Attested', description: 'Has received attestations from other agents or users' },
  trusted_by_many: { label: 'Trusted by Many', description: 'Multiple positive attestations from the community' },
  said_verified: { label: 'SAID Verified', description: 'Identity verified through SAID Protocol' },
  said_trusted: { label: 'SAID Trusted', description: 'Achieved high trust tier on SAID Protocol' },
  x402_enabled: { label: 'x402 Enabled', description: 'Offers paid services via x402 protocol' },
  mcp_available: { label: 'MCP Available', description: 'Has Model Context Protocol endpoint' },
  skill_provider: { label: 'Skill Provider', description: 'Registered skills available for hire' }
};

// =============================================================================
// SKILL CATEGORIES
// =============================================================================

const SKILL_CATEGORIES = {
  defi: { label: 'DeFi', description: 'Yield optimization, lending, trading, liquidity' },
  data: { label: 'Data & Analytics', description: 'On-chain data, market analysis, insights' },
  social: { label: 'Social & Content', description: 'Social media, content creation, community' },
  trading: { label: 'Trading', description: 'Automated trading, arbitrage, signals' },
  nft: { label: 'NFT', description: 'NFT minting, metadata, marketplace operations' },
  infrastructure: { label: 'Infrastructure', description: 'RPC, indexing, compute, storage' },
  security: { label: 'Security', description: 'Auditing, monitoring, rug detection' },
  ai: { label: 'AI & ML', description: 'Inference, training, embeddings, agents' },
  utility: { label: 'Utility', description: 'General purpose tools and automation' }
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
    const response = await fetch(
      `${CONFIG.X402_BAZAAR_API}?limit=100`,
      { headers: { 'accept': 'application/json' } }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (e) {
    console.error('x402 Bazaar API error:', e.message);
    return [];
  }
}

async function getX402CommunityServices() {
  try {
    const response = await fetch(
      `${CONFIG.X402_COMMUNITY_API}/services`,
      { headers: { 'accept': 'application/json' } }
    );
    if (!response.ok) return [];
    return await response.json();
  } catch (e) {
    console.error('x402 Community API error:', e.message);
    return [];
  }
}

// =============================================================================
// SCORING FUNCTIONS
// =============================================================================

function calculateFeatures(data) {
  const f = data.features || {};
  
  const ageScore = f.wallet_age_score || 0;
  const activeScore = f.active_days || 0;
  const longevity = Math.round((ageScore + activeScore) / 2);
  
  const txScore = f.tx_count || 0;
  const diversityScore = f.platform_diversity || 0;
  const experience = Math.round((txScore + diversityScore) / 2);
  
  const convictionRatio = f.conviction_ratio || 0;
  const holdScore = f.median_hold_days || 0;
  const noDumps = (f.no_instant_dumps || 0) * 100;
  const conviction = Math.round((convictionRatio + holdScore + noDumps) / 3);
  
  const majorScore = f.major_percentile_score || 0;
  const stableScore = f.stable_percentile_score || 0;
  const capital = Math.round((majorScore + stableScore) / 2);
  
  return {
    longevity: Math.min(longevity, 100),
    experience: Math.min(experience, 100),
    conviction: Math.min(conviction, 100),
    capital: Math.min(capital, 100)
  };
}

function calculateBadges(fairscaleData, saidData, agentRecord) {
  const f = fairscaleData?.features || {};
  const badges = [];
  
  if ((f.wallet_age_score || 0) >= 60) badges.push({ ...BADGE_DEFINITIONS.established, id: 'established' });
  if ((f.conviction_ratio || 0) >= 70) badges.push({ ...BADGE_DEFINITIONS.committed, id: 'committed' });
  if ((f.major_percentile_score || 0) >= 60) badges.push({ ...BADGE_DEFINITIONS.capitalised, id: 'capitalised' });
  if ((f.platform_diversity || 0) >= 50) badges.push({ ...BADGE_DEFINITIONS.diverse, id: 'diverse' });
  if ((f.tx_count || 0) >= 60) badges.push({ ...BADGE_DEFINITIONS.experienced, id: 'experienced' });
  if ((f.median_hold_days || 0) >= 60) badges.push({ ...BADGE_DEFINITIONS.holder, id: 'holder' });
  if ((f.net_sol_flow_30d || 0) > 50) badges.push({ ...BADGE_DEFINITIONS.net_positive, id: 'net_positive' });
  if ((f.lst_percentile_score || 0) >= 40) badges.push({ ...BADGE_DEFINITIONS.staker, id: 'staker' });
  
  const hasSocial = (fairscaleData?.social_score || 0) >= 30 || saidData?.identity?.twitter;
  if (hasSocial) badges.push({ ...BADGE_DEFINITIONS.social, id: 'social' });
  
  const feedbackCount = saidData?.reputation?.feedbackCount || 0;
  if (feedbackCount >= 1) badges.push({ ...BADGE_DEFINITIONS.attested, id: 'attested' });
  if (feedbackCount >= 5) badges.push({ ...BADGE_DEFINITIONS.trusted_by_many, id: 'trusted_by_many' });
  
  if (saidData?.verified) badges.push({ ...BADGE_DEFINITIONS.said_verified, id: 'said_verified' });
  if (saidData?.reputation?.trustTier === 'high') badges.push({ ...BADGE_DEFINITIONS.said_trusted, id: 'said_trusted' });
  
  // Registry-specific badges
  if (agentRecord?.services?.length > 0) badges.push({ ...BADGE_DEFINITIONS.x402_enabled, id: 'x402_enabled' });
  if (agentRecord?.endpoints?.mcp || saidData?.endpoints?.mcp) badges.push({ ...BADGE_DEFINITIONS.mcp_available, id: 'mcp_available' });
  if (agentRecord?.skills?.length > 0) badges.push({ ...BADGE_DEFINITIONS.skill_provider, id: 'skill_provider' });
  
  return badges;
}

function calculateAgentFairScore(features, saidData, agentRecord) {
  const fairscaleScore = (features.longevity + features.experience + features.conviction + features.capital) / 4;
  const saidScore = saidData?.reputation?.score || 0;
  
  let score = (fairscaleScore * 0.60) + (saidScore * 0.40);
  
  // Attestation bonus (up to +10)
  const feedbackCount = saidData?.reputation?.feedbackCount || 0;
  score += Math.min(feedbackCount * 3, 10);
  
  // SAID bonuses
  if (saidData?.verified) score += 10;
  if (saidData?.reputation?.trustTier === 'high') score += 5;
  
  // Registry bonuses (for being a productive agent)
  if (agentRecord?.skills?.length > 0) score += 3;
  if (agentRecord?.services?.length > 0) score += 3;
  if (agentRecord?.endpoints?.mcp) score += 2;
  
  return Math.min(Math.round(score), 100);
}

// =============================================================================
// REGISTRY MANAGEMENT
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
  
  // Process Bazaar services
  for (const svc of bazaarServices) {
    const serviceId = `bazaar_${generateId()}`;
    const serviceRecord = {
      id: serviceId,
      source: 'x402_bazaar',
      resource: svc.resource,
      type: svc.type || 'http',
      pricing: svc.accepts?.[0] || null,
      metadata: svc.metadata || null,
      discoveredAt: new Date().toISOString(),
      lastChecked: new Date().toISOString()
    };
    
    // Check if already exists
    const existing = Array.from(REGISTRY.services.values()).find(s => s.resource === svc.resource);
    if (!existing) {
      REGISTRY.services.set(serviceId, serviceRecord);
      added++;
    }
  }
  
  // Process Community services
  for (const svc of communityServices) {
    const serviceId = `community_${generateId()}`;
    const serviceRecord = {
      id: serviceId,
      source: 'x402_community',
      resource: svc.url || svc.resource,
      name: svc.name,
      description: svc.description,
      category: svc.category,
      pricing: { price: svc.price_usd, network: svc.network },
      health: svc.health || null,
      discoveredAt: new Date().toISOString(),
      lastChecked: new Date().toISOString()
    };
    
    const existing = Array.from(REGISTRY.services.values()).find(s => s.resource === serviceRecord.resource);
    if (!existing) {
      REGISTRY.services.set(serviceId, serviceRecord);
      added++;
    }
  }
  
  REGISTRY.lastSync = new Date().toISOString();
  console.log(`Synced ${added} new services. Total: ${REGISTRY.services.size}`);
  
  return { added, total: REGISTRY.services.size };
}

async function getOrCreateAgent(wallet) {
  // Check if in registry
  if (REGISTRY.agents.has(wallet)) {
    return REGISTRY.agents.get(wallet);
  }
  
  // Fetch from sources
  const [fairscaleData, saidData] = await Promise.all([
    getFairScaleScore(wallet),
    getSAIDData(wallet)
  ]);
  
  if (!fairscaleData && !saidData) {
    return null;
  }
  
  // Create agent record
  const features = fairscaleData ? calculateFeatures(fairscaleData) : { longevity: 0, experience: 0, conviction: 0, capital: 0 };
  
  const agentRecord = {
    wallet,
    sources: [],
    name: saidData?.identity?.name || null,
    description: saidData?.identity?.description || null,
    skills: saidData?.skills || [],
    services: [],
    endpoints: {
      mcp: saidData?.endpoints?.mcp || null,
      a2a: saidData?.endpoints?.a2a || null
    },
    social: {
      twitter: saidData?.identity?.twitter || null,
      website: saidData?.identity?.website || null
    },
    registeredAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString()
  };
  
  if (fairscaleData) agentRecord.sources.push('fairscale');
  if (saidData?.registered) agentRecord.sources.push('said');
  
  // Calculate scores
  agentRecord.scores = {
    fairscore: calculateAgentFairScore(features, saidData, agentRecord),
    fairscore_base: Math.round(fairscaleData?.fairscore || 0),
    said_score: saidData?.reputation?.score || null,
    said_trust_tier: saidData?.reputation?.trustTier || null,
    attestations: saidData?.reputation?.feedbackCount || 0
  };
  
  agentRecord.features = features;
  agentRecord.badges = calculateBadges(fairscaleData, saidData, agentRecord);
  
  // Cache in registry
  REGISTRY.agents.set(wallet, agentRecord);
  
  return agentRecord;
}

// =============================================================================
// ROUTES - CORE
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Agent Registry',
    version: '6.0.0',
    status: 'ok',
    tagline: 'The Trust & Discovery Layer for Solana\'s Agentic Economy',
    description: 'Aggregated agent registry with reputation-weighted discovery',
    stats: {
      agents: REGISTRY.agents.size,
      services: REGISTRY.services.size,
      skills: REGISTRY.skills.size,
      lastSync: REGISTRY.lastSync
    },
    endpoints: {
      'GET /registry': 'List all registered agents',
      'GET /registry/:wallet': 'Get full agent profile',
      'POST /registry/register': 'Register a new agent',
      'GET /services': 'List x402 services with FairScores',
      'GET /skills': 'Browse skill categories',
      'POST /skills/register': 'Register agent skills',
      'GET /discover': 'AI-friendly discovery endpoint',
      'GET /score': 'Quick reputation score (legacy)',
      'POST /sync': 'Trigger x402 service sync'
    },
    sources: ['FairScale', 'SAID Protocol', 'x402 Bazaar', 'x402 Community', 'Manual'],
    docs: 'https://docs.fairscale.xyz'
  });
});

// =============================================================================
// ROUTES - REGISTRY
// =============================================================================

app.get('/registry', async (req, res) => {
  const { 
    minScore = 0, 
    verified, 
    hasSkills, 
    hasServices,
    category,
    sort = 'score',
    limit = 50,
    offset = 0 
  } = req.query;
  
  let agents = Array.from(REGISTRY.agents.values());
  
  // Filters
  if (minScore > 0) {
    agents = agents.filter(a => a.scores.fairscore >= Number(minScore));
  }
  
  if (verified === 'true') {
    agents = agents.filter(a => a.badges.some(b => b.id === 'said_verified'));
  }
  
  if (hasSkills === 'true') {
    agents = agents.filter(a => a.skills?.length > 0);
  }
  
  if (hasServices === 'true') {
    agents = agents.filter(a => a.services?.length > 0);
  }
  
  if (category) {
    agents = agents.filter(a => a.skills?.some(s => s.category === category));
  }
  
  // Sort
  if (sort === 'score') {
    agents.sort((a, b) => b.scores.fairscore - a.scores.fairscore);
  } else if (sort === 'recent') {
    agents.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
  } else if (sort === 'attestations') {
    agents.sort((a, b) => b.scores.attestations - a.scores.attestations);
  }
  
  // Pagination
  const total = agents.length;
  agents = agents.slice(Number(offset), Number(offset) + Number(limit));
  
  // Slim down for list view
  const results = agents.map(a => ({
    wallet: a.wallet,
    name: a.name || `Agent ${a.wallet.slice(0, 8)}...`,
    fairscore: a.scores.fairscore,
    verified: a.badges.some(b => b.id === 'said_verified'),
    attestations: a.scores.attestations,
    skills: a.skills?.length || 0,
    services: a.services?.length || 0,
    badges: a.badges.slice(0, 5).map(b => b.id),
    sources: a.sources
  }));
  
  res.json({
    total,
    offset: Number(offset),
    limit: Number(limit),
    agents: results
  });
});

app.get('/registry/:wallet', async (req, res) => {
  const { wallet } = req.params;
  
  const agent = await getOrCreateAgent(wallet);
  
  if (!agent) {
    return res.status(404).json({ 
      error: 'Agent not found',
      wallet,
      suggestion: 'Register this wallet using POST /registry/register'
    });
  }
  
  res.json(agent);
});

app.post('/registry/register', async (req, res) => {
  const { 
    wallet, 
    name, 
    description, 
    skills = [],
    endpoints = {},
    social = {}
  } = req.body;
  
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  
  // Validate wallet format (basic check)
  if (wallet.length < 32 || wallet.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }
  
  // Fetch or create
  let agent = await getOrCreateAgent(wallet);
  
  if (!agent) {
    // Create minimal record
    agent = {
      wallet,
      sources: ['manual'],
      name: name || null,
      description: description || null,
      skills: [],
      services: [],
      endpoints: {},
      social: {},
      scores: { fairscore: 0, fairscore_base: 0, said_score: null, said_trust_tier: null, attestations: 0 },
      features: { longevity: 0, experience: 0, conviction: 0, capital: 0 },
      badges: [],
      registeredAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
  }
  
  // Update with provided data
  if (name) agent.name = name;
  if (description) agent.description = description;
  if (endpoints.mcp) agent.endpoints.mcp = endpoints.mcp;
  if (endpoints.a2a) agent.endpoints.a2a = endpoints.a2a;
  if (social.twitter) agent.social.twitter = social.twitter;
  if (social.website) agent.social.website = social.website;
  
  // Add skills
  if (skills.length > 0) {
    for (const skill of skills) {
      if (!skill.name || !skill.category) continue;
      
      const skillId = `${wallet.slice(0, 8)}_${generateId()}`;
      const skillRecord = {
        id: skillId,
        agentWallet: wallet,
        name: skill.name,
        category: skill.category,
        description: skill.description || '',
        pricing: skill.pricing || null,
        createdAt: new Date().toISOString()
      };
      
      REGISTRY.skills.set(skillId, skillRecord);
      agent.skills.push(skillRecord);
    }
    
    // Add skill provider badge
    if (!agent.badges.some(b => b.id === 'skill_provider')) {
      agent.badges.push({ ...BADGE_DEFINITIONS.skill_provider, id: 'skill_provider' });
    }
  }
  
  // Add manual source if not present
  if (!agent.sources.includes('manual')) {
    agent.sources.push('manual');
  }
  
  agent.lastUpdated = new Date().toISOString();
  
  // Save
  REGISTRY.agents.set(wallet, agent);
  
  res.json({
    success: true,
    message: 'Agent registered successfully',
    agent
  });
});

// =============================================================================
// ROUTES - SERVICES
// =============================================================================

app.get('/services', async (req, res) => {
  const {
    category,
    maxPrice,
    network,
    hasHealth,
    limit = 50,
    offset = 0
  } = req.query;
  
  // Sync if empty or stale
  if (REGISTRY.services.size === 0) {
    await syncX402Services();
  }
  
  let services = Array.from(REGISTRY.services.values());
  
  // Filters
  if (category) {
    services = services.filter(s => s.category === category);
  }
  
  if (maxPrice) {
    services = services.filter(s => {
      const price = s.pricing?.price || s.pricing?.maxAmountRequired;
      if (!price) return true;
      return Number(price) <= Number(maxPrice);
    });
  }
  
  if (network) {
    services = services.filter(s => s.pricing?.network?.includes(network));
  }
  
  if (hasHealth === 'true') {
    services = services.filter(s => s.health?.uptime);
  }
  
  // Pagination
  const total = services.length;
  services = services.slice(Number(offset), Number(offset) + Number(limit));
  
  res.json({
    total,
    offset: Number(offset),
    limit: Number(limit),
    services: services.map(s => ({
      id: s.id,
      source: s.source,
      name: s.name || s.resource,
      resource: s.resource,
      description: s.description || null,
      category: s.category || 'utility',
      pricing: s.pricing,
      health: s.health || null,
      discoveredAt: s.discoveredAt
    }))
  });
});

// =============================================================================
// ROUTES - SKILLS
// =============================================================================

app.get('/skills', (req, res) => {
  const { category, limit = 50, offset = 0 } = req.query;
  
  let skills = Array.from(REGISTRY.skills.values());
  
  if (category) {
    skills = skills.filter(s => s.category === category);
  }
  
  const total = skills.length;
  skills = skills.slice(Number(offset), Number(offset) + Number(limit));
  
  res.json({
    categories: SKILL_CATEGORIES,
    total,
    offset: Number(offset),
    limit: Number(limit),
    skills
  });
});

app.post('/skills/register', async (req, res) => {
  const { wallet, skills } = req.body;
  
  if (!wallet || !skills || !Array.isArray(skills)) {
    return res.status(400).json({ error: 'wallet and skills array required' });
  }
  
  let agent = await getOrCreateAgent(wallet);
  if (!agent) {
    agent = {
      wallet,
      sources: ['manual'],
      skills: [],
      badges: [],
      registeredAt: new Date().toISOString()
    };
    REGISTRY.agents.set(wallet, agent);
  }
  
  const added = [];
  
  for (const skill of skills) {
    if (!skill.name || !skill.category) continue;
    
    if (!SKILL_CATEGORIES[skill.category]) {
      continue; // Invalid category
    }
    
    const skillId = `${wallet.slice(0, 8)}_${generateId()}`;
    const skillRecord = {
      id: skillId,
      agentWallet: wallet,
      name: skill.name,
      category: skill.category,
      description: skill.description || '',
      pricing: skill.pricing || null,
      createdAt: new Date().toISOString()
    };
    
    REGISTRY.skills.set(skillId, skillRecord);
    agent.skills.push(skillRecord);
    added.push(skillRecord);
  }
  
  if (added.length > 0 && !agent.badges.some(b => b.id === 'skill_provider')) {
    agent.badges.push({ ...BADGE_DEFINITIONS.skill_provider, id: 'skill_provider' });
  }
  
  res.json({
    success: true,
    added: added.length,
    skills: added
  });
});

// =============================================================================
// ROUTES - DISCOVERY (AI-FRIENDLY)
// =============================================================================

app.get('/discover', async (req, res) => {
  const {
    query,
    type = 'all', // all, agents, services, skills
    minScore = 0,
    verified,
    category,
    maxPrice,
    limit = 10
  } = req.query;
  
  const results = {
    query,
    timestamp: new Date().toISOString(),
    agents: [],
    services: [],
    skills: []
  };
  
  // Search agents
  if (type === 'all' || type === 'agents') {
    let agents = Array.from(REGISTRY.agents.values());
    
    if (query) {
      const q = query.toLowerCase();
      agents = agents.filter(a => 
        a.name?.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.skills?.some(s => s.name.toLowerCase().includes(q))
      );
    }
    
    if (minScore > 0) {
      agents = agents.filter(a => a.scores.fairscore >= Number(minScore));
    }
    
    if (verified === 'true') {
      agents = agents.filter(a => a.badges.some(b => b.id === 'said_verified'));
    }
    
    if (category) {
      agents = agents.filter(a => a.skills?.some(s => s.category === category));
    }
    
    agents.sort((a, b) => b.scores.fairscore - a.scores.fairscore);
    
    results.agents = agents.slice(0, Number(limit)).map(a => ({
      wallet: a.wallet,
      name: a.name || `Agent ${a.wallet.slice(0, 8)}...`,
      description: a.description,
      fairscore: a.scores.fairscore,
      verified: a.badges.some(b => b.id === 'said_verified'),
      skills: a.skills?.map(s => s.name) || [],
      endpoints: a.endpoints,
      recommendation: generateRecommendation(a)
    }));
  }
  
  // Search services
  if (type === 'all' || type === 'services') {
    let services = Array.from(REGISTRY.services.values());
    
    if (query) {
      const q = query.toLowerCase();
      services = services.filter(s => 
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.resource?.toLowerCase().includes(q)
      );
    }
    
    if (category) {
      services = services.filter(s => s.category === category);
    }
    
    if (maxPrice) {
      services = services.filter(s => {
        const price = s.pricing?.price || 0;
        return Number(price) <= Number(maxPrice);
      });
    }
    
    results.services = services.slice(0, Number(limit)).map(s => ({
      id: s.id,
      name: s.name || s.resource,
      resource: s.resource,
      description: s.description,
      category: s.category,
      pricing: s.pricing,
      source: s.source
    }));
  }
  
  // Search skills
  if (type === 'all' || type === 'skills') {
    let skills = Array.from(REGISTRY.skills.values());
    
    if (query) {
      const q = query.toLowerCase();
      skills = skills.filter(s => 
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q)
      );
    }
    
    if (category) {
      skills = skills.filter(s => s.category === category);
    }
    
    results.skills = skills.slice(0, Number(limit));
  }
  
  res.json(results);
});

function generateRecommendation(agent) {
  const score = agent.scores.fairscore;
  const verified = agent.badges.some(b => b.id === 'said_verified');
  const attestations = agent.scores.attestations || 0;
  
  if (score >= 80 && verified && attestations >= 5) {
    return 'Highly recommended - verified identity with strong track record';
  } else if (score >= 60 && verified) {
    return 'Recommended - verified with good reputation';
  } else if (score >= 60) {
    return 'Good reputation but consider requesting verification';
  } else if (verified) {
    return 'Verified but limited track record - proceed with caution';
  } else {
    return 'Limited reputation - request attestations before engaging';
  }
}

// =============================================================================
// ROUTES - LEGACY COMPATIBILITY
// =============================================================================

app.get('/score', async (req, res) => {
  const { wallet } = req.query;
  
  if (!wallet) {
    return res.status(400).json({ error: 'Missing wallet parameter' });
  }
  
  const agent = await getOrCreateAgent(wallet);
  
  if (!agent) {
    return res.status(500).json({ error: 'Failed to fetch score', wallet });
  }
  
  // Return v5-compatible format
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
      skills: agent.skills?.map(s => s.name) || [],
      serviceTypes: [...new Set(agent.skills?.map(s => s.category) || [])],
      endpoints: agent.endpoints,
      attestations: {
        count: agent.scores.attestations,
        trustTier: agent.scores.said_trust_tier
      },
      tier: agent.scores.fairscore >= 80 ? 'gold' : agent.scores.fairscore >= 60 ? 'silver' : 'bronze'
    },
    social: agent.social,
    said: {
      registered: agent.sources.includes('said'),
      verified: agent.badges.some(b => b.id === 'said_verified'),
      score: agent.scores.said_score,
      trustTier: agent.scores.said_trust_tier,
      feedbackCount: agent.scores.attestations
    }
  });
});

// =============================================================================
// ROUTES - ADMIN
// =============================================================================

app.post('/sync', async (req, res) => {
  const result = await syncX402Services();
  res.json({
    success: true,
    ...result,
    lastSync: REGISTRY.lastSync
  });
});

app.get('/stats', (req, res) => {
  const agents = Array.from(REGISTRY.agents.values());
  const services = Array.from(REGISTRY.services.values());
  const skills = Array.from(REGISTRY.skills.values());
  
  const verifiedAgents = agents.filter(a => a.badges.some(b => b.id === 'said_verified')).length;
  const avgScore = agents.length > 0 
    ? Math.round(agents.reduce((sum, a) => sum + a.scores.fairscore, 0) / agents.length)
    : 0;
  
  const skillsByCategory = {};
  for (const cat of Object.keys(SKILL_CATEGORIES)) {
    skillsByCategory[cat] = skills.filter(s => s.category === cat).length;
  }
  
  const servicesBySource = {
    x402_bazaar: services.filter(s => s.source === 'x402_bazaar').length,
    x402_community: services.filter(s => s.source === 'x402_community').length
  };
  
  res.json({
    timestamp: new Date().toISOString(),
    lastSync: REGISTRY.lastSync,
    totals: {
      agents: agents.length,
      services: services.length,
      skills: skills.length
    },
    agents: {
      total: agents.length,
      verified: verifiedAgents,
      avgScore,
      withSkills: agents.filter(a => a.skills?.length > 0).length,
      withServices: agents.filter(a => a.services?.length > 0).length
    },
    services: servicesBySource,
    skills: skillsByCategory
  });
});

// =============================================================================
// 404
// =============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    endpoints: {
      'GET /': 'API info and stats',
      'GET /registry': 'List agents',
      'GET /registry/:wallet': 'Get agent profile',
      'POST /registry/register': 'Register agent',
      'GET /services': 'List x402 services',
      'GET /skills': 'Browse skills',
      'POST /skills/register': 'Register skills',
      'GET /discover': 'AI-friendly search',
      'GET /score': 'Legacy score endpoint',
      'GET /stats': 'Registry statistics'
    }
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                     FairScale Agent Registry v6.0                         ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║   The Trust & Discovery Layer for Solana's Agentic Economy               ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║   Port: ${CONFIG.PORT}                                                              ║
║                                                                           ║
║   Core Endpoints:                                                         ║
║     GET  /registry          List all registered agents                    ║
║     GET  /registry/:wallet  Full agent profile with FairScore             ║
║     POST /registry/register Register an agent                             ║
║     GET  /services          x402 services with reputation                 ║
║     GET  /skills            Browse skill marketplace                      ║
║     POST /skills/register   Register agent skills                         ║
║     GET  /discover          AI-friendly discovery                         ║
║                                                                           ║
║   Data Sources:                                                           ║
║     • FairScale (on-chain reputation)                                     ║
║     • SAID Protocol (identity & attestations)                             ║
║     • x402 Bazaar (Coinbase service discovery)                            ║
║     • x402 Community (extended service catalog)                           ║
║     • Manual registrations                                                ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
  
  // Initial sync
  console.log('Performing initial x402 service sync...');
  await syncX402Services();
});
