import express from ‘express’;
import cors from ‘cors’;
import ‘dotenv/config’;

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
FAIRSCALE_API: ‘https://api.fairscale.xyz’,
FAIRSCALE_API_KEY: process.env.FAIRSCALE_API_KEY,
SAID_API: ‘https://api.saidprotocol.com’,
HELIUS_API_KEY: process.env.HELIUS_API_KEY || ‘’,
HELIUS_RPC: ‘https://mainnet.helius-rpc.com’,
PAYMENT_ADDRESS: ‘fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN’,
USDC_MINT: ‘EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v’,
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
{ headers: { ‘accept’: ‘application/json’, ‘fairkey’: CONFIG.FAIRSCALE_API_KEY } }
);
if (!response.ok) return null;
return await response.json();
} catch (e) {
console.error(‘FairScale error:’, e.message);
return null;
}
}

async function getSAIDData(wallet) {
try {
const response = await fetch(
`${CONFIG.SAID_API}/api/verify/${encodeURIComponent(wallet)}`,
{ headers: { ‘accept’: ‘application/json’ } }
);
if (!response.ok) return null;
return await response.json();
} catch (e) {
console.error(‘SAID error:’, e.message);
return null;
}
}

// =============================================================================
// PAYMENT VERIFICATION
// =============================================================================

async function verifyPayment(senderWallet) {
if (!CONFIG.HELIUS_API_KEY) {
return { verified: false, error: ‘Payment verification not configured’ };
}

try {
const sigResponse = await fetch(`${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({
jsonrpc: ‘2.0’, id: 1,
method: ‘getSignaturesForAddress’,
params: [CONFIG.PAYMENT_ADDRESS, { limit: 100 }]
})
});

```
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
```

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
high: ‘High transaction volume across multiple protocols’,
mid: ‘Moderate on-chain activity’,
low: ‘Limited transaction history’
},
holdings: {
high: ‘Strong token positions (SOL, LST, stables)’,
mid: ‘Moderate token holdings’,
low: ‘Minimal token positions’
},
reliability: {
high: ‘No panic sells, consistent behavior’,
mid: ‘Generally stable patterns’,
low: ‘Variable transaction patterns’
},
history: {
high: ‘Established wallet with holding history’,
mid: ‘Some track record’,
low: ‘New or limited history’
}
};

const tier = value >= 50 ? ‘high’ : value >= 25 ? ‘mid’ : ‘low’;
return descriptions[feature]?.[tier] || ‘’;
}

// =============================================================================
// AGENT FAIRSCORE CALCULATION
// =============================================================================

function calculateAgentFairScore(fairscaleData, features, saidData, wallet) {
// FairScale’s score (40%)
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
if (saidData?.reputation?.trustTier === ‘high’) bonuses += 3;

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
activity: getFeatureDescription(‘activity’, features.activity),
holdings: getFeatureDescription(‘holdings’, features.holdings),
reliability: getFeatureDescription(‘reliability’, features.reliability),
history: getFeatureDescription(‘history’, features.history)
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

app.get(’/’, (req, res) => {
res.json({
service: ‘FairScale Agent Registry’,
version: ‘9.1.0’,
endpoints: {
‘GET /score’: ‘Get agent score’,
‘POST /register’: ‘Register agent’,
‘POST /verify’: ‘Verify payment’,
‘POST /service’: ‘Register x402 service’,
‘GET /services’: ‘List services’,
‘GET /directory’: ‘List agents’
}
});
});

app.get(’/score’, async (req, res) => {
const { wallet } = req.query;
if (!wallet) return res.status(400).json({ error: ‘Missing wallet’ });

const agent = await getOrCreateAgent(wallet);
if (!agent) return res.status(404).json({ error: ‘Could not fetch data’, wallet });

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

app.post(’/register’, async (req, res) => {
const { wallet, name, description, website, mcp } = req.body;

if (!wallet) return res.status(400).json({ error: ‘Missing wallet’ });

REGISTRY.registeredAgents.set(wallet, {
wallet, name, description, website, mcp,
registeredAt: new Date().toISOString()
});

REGISTRY.agents.delete(wallet);
const agent = await getOrCreateAgent(wallet);

res.json({
success: true,
message: ‘Agent registered’,
agent: agent ? {
wallet,
name: agent.name,
agent_fairscore: agent.scores.agent_fairscore
} : null
});
});

app.post(’/service’, async (req, res) => {
const { wallet, url, name, description, price, category } = req.body;

if (!wallet || !url || !name) {
return res.status(400).json({ error: ‘Missing wallet, url, or name’ });
}

const serviceId = `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

REGISTRY.services.set(serviceId, {
id: serviceId,
wallet,
url,
name,
description: description || ‘’,
price: price || ‘Contact’,
category: category || ‘utility’,
network: ‘solana’,
registeredAt: new Date().toISOString()
});

res.json({ success: true, serviceId, message: ‘Service registered’ });
});

app.post(’/verify’, async (req, res) => {
const { wallet } = req.body;
if (!wallet) return res.status(400).json({ error: ‘Missing wallet’ });

if (REGISTRY.verifiedWallets.has(wallet)) {
return res.json({ success: true, message: ‘Already verified’ });
}

const result = await verifyPayment(wallet);

if (result.verified) {
REGISTRY.verifiedWallets.set(wallet, {
verifiedAt: new Date().toISOString(),
txSignature: result.txSignature
});
REGISTRY.agents.delete(wallet);
return res.json({ success: true, message: ‘+8 score boost applied’, txSignature: result.txSignature });
}

res.status(400).json({ success: false, error: result.error, paymentAddress: CONFIG.PAYMENT_ADDRESS });
});

app.get(’/services’, (req, res) => {
const services = Array.from(REGISTRY.services.values());
res.json({ total: services.length, network: ‘solana’, services });
});

app.get(’/directory’, (req, res) => {
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

// Bulk import agents (admin)
app.post(’/admin/bulk-import’, async (req, res) => {
const { wallets, apiKey } = req.body;

// Simple API key check - change this to your own secret
if (apiKey !== process.env.ADMIN_API_KEY) {
return res.status(401).json({ error: ‘Invalid API key’ });
}

if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
return res.status(400).json({ error: ‘wallets must be a non-empty array’ });
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
results.failed.push({ wallet, reason: ‘Could not fetch data’ });
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
app.post(’/admin/sync-said’, async (req, res) => {
const { apiKey } = req.body;

if (apiKey !== process.env.ADMIN_API_KEY) {
return res.status(401).json({ error: ‘Invalid API key’ });
}

try {
// Fetch all agents from SAID
const saidResponse = await fetch(`${CONFIG.SAID_API}/api/agents?limit=500`);
if (!saidResponse.ok) {
return res.status(500).json({ error: ‘Failed to fetch from SAID API’ });
}

```
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
```

} catch (e) {
res.status(500).json({ error: e.message });
}
});

app.get(’/stats’, (req, res) => {
res.json({
agents: REGISTRY.agents.size,
registered: REGISTRY.registeredAgents.size,
verified: REGISTRY.verifiedWallets.size,
services: REGISTRY.services.size
});
});

// =============================================================================
// SAID AUTO-SYNC
// =============================================================================

async function syncFromSAID() {
console.log(’[SAID Sync] Starting…’);

try {
const saidResponse = await fetch(`${CONFIG.SAID_API}/api/agents?limit=500`);
if (!saidResponse.ok) {
console.error(’[SAID Sync] Failed to fetch:’, saidResponse.status);
return;
}

```
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
```

} catch (e) {
console.error(’[SAID Sync] Error:’, e.message);
}
}

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
console.log(`FairScale Registry v9.2 on port ${CONFIG.PORT}`);

// Sync from SAID on startup (after 5 second delay)
setTimeout(syncFromSAID, 5000);

// Re-sync daily (every 24 hours)
setInterval(syncFromSAID, 24 * 60 * 60 * 1000);
});

