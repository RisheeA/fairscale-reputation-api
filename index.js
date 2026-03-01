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
  PORT: process.env.PORT || 8080
};

// =============================================================================
// API CLIENTS
// =============================================================================

async function getFairScaleScore(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.FAIRSCALE_API}/score?wallet=${encodeURIComponent(wallet)}`,
      {
        headers: {
          'accept': 'application/json',
          'fairkey': CONFIG.FAIRSCALE_API_KEY
        }
      }
    );
    
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.error('FairScale API error:', e.message);
    return null;
  }
}

async function getSAIDScore(wallet) {
  try {
    const response = await fetch(
      `${CONFIG.SAID_API}/api/verify/${encodeURIComponent(wallet)}`,
      {
        headers: {
          'accept': 'application/json'
        }
      }
    );
    
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.error('SAID API error:', e.message);
    return null;
  }
}

// =============================================================================
// SCORING FUNCTIONS
// =============================================================================

function calculateFeatures(data) {
  const f = data.features || {};
  
  // Longevity: Age + Active days (agent-friendly: 30 days = max)
  const ageScore = Math.min((f.wallet_age_days || 0) / 30, 1);
  const activeScore = Math.min((f.active_days || 0) / 14, 1);
  const longevity = Math.round(((ageScore * 0.5) + (activeScore * 0.5)) * 100);
  
  // Experience: Transaction count + Platform diversity (agent-friendly: 50 txs = max)
  const txScore = Math.min((f.tx_count || 0) / 50, 1);
  const diversityScore = f.platform_diversity || 0;
  const experience = Math.round(((txScore * 0.5) + (diversityScore * 0.5)) * 100);
  
  // Conviction: Conviction ratio + Hold days + No dumps
  const convictionRatio = f.conviction_ratio || 0;
  const holdScore = Math.min((f.median_hold_days || 0) / 7, 1);
  const noDumps = f.no_instant_dumps || 0;
  const conviction = Math.round(((convictionRatio * 0.4) + (holdScore * 0.3) + (noDumps * 0.3)) * 100);
  
  // Capital: Major holdings + Net positive flow
  const majorScore = f.major_percentile_score || 0;
  const netFlow = f.net_sol_flow_30d || 0;
  const netPositive = netFlow > 0 ? Math.min(netFlow / 100, 1) : 0;
  const capital = Math.round(((majorScore * 0.5) + (netPositive * 0.5)) * 100);
  
  return {
    longevity: Math.min(longevity, 100),
    experience: Math.min(experience, 100),
    conviction: Math.min(conviction, 100),
    capital: Math.min(capital, 100)
  };
}

function calculateBadges(data, saidData) {
  const f = data.features || {};
  const badges = [];
  
  // Established: Wallet over 1 year
  if ((f.wallet_age_days || 0) >= 365) {
    badges.push({ id: 'established', label: 'Established' });
  }
  
  // Committed: High conviction ratio
  if ((f.conviction_ratio || 0) >= 0.7) {
    badges.push({ id: 'committed', label: 'Committed' });
  }
  
  // Capitalised: Top 20% holdings
  if ((f.major_percentile_score || 0) >= 0.8) {
    badges.push({ id: 'capitalised', label: 'Capitalised' });
  }
  
  // Diverse: Uses many protocols
  if ((f.platform_diversity || 0) >= 0.7) {
    badges.push({ id: 'diverse', label: 'Diverse' });
  }
  
  // Experienced: 500+ transactions
  if ((f.tx_count || 0) >= 500) {
    badges.push({ id: 'experienced', label: 'Experienced' });
  }
  
  // Holder: Holds tokens 2+ weeks
  if ((f.median_hold_days || 0) >= 14) {
    badges.push({ id: 'holder', label: 'Holder' });
  }
  
  // Net Positive: Adding capital
  if ((f.net_sol_flow_30d || 0) > 0) {
    badges.push({ id: 'net_positive', label: 'Net Positive' });
  }
  
  // Staker: Active staker
  if ((f.lst_percentile_score || 0) >= 0.7) {
    badges.push({ id: 'staker', label: 'Staker' });
  }
  
  // Social: Connected accounts (FairScale or SAID)
  const hasFairScaleSocial = (data.social_score || 0) >= 50;
  const hasSAIDSocial = saidData?.identity?.twitter || saidData?.identity?.website;
  if (hasFairScaleSocial || hasSAIDSocial) {
    badges.push({ id: 'social', label: 'Social' });
  }
  
  // SAID Verified
  if (saidData?.verified) {
    badges.push({ id: 'said_verified', label: 'SAID Verified' });
  }
  
  // SAID Trusted
  if (saidData?.reputation?.trustTier === 'high') {
    badges.push({ id: 'said_trusted', label: 'SAID Trusted' });
  }
  
  return badges;
}

function calculateTrustScores(features, saidScore) {
  const said = saidScore || 0;
  
  // Lending: Capital heavy
  const lending = Math.round(
    (features.capital * 0.35) +
    (features.conviction * 0.30) +
    (features.longevity * 0.20) +
    (said * 0.15)
  );
  
  // OTC: Longevity + Experience heavy
  const otc = Math.round(
    (features.longevity * 0.30) +
    (features.experience * 0.25) +
    (features.conviction * 0.25) +
    (said * 0.20)
  );
  
  return {
    lending: Math.min(lending, 100),
    otc: Math.min(otc, 100)
  };
}

function calculateAgentScore(features, socialCombined, saidScore, saidVerified) {
  // FairScale component (60%)
  const fairscaleScore = (
    (features.longevity * 0.25) +
    (features.experience * 0.25) +
    (features.conviction * 0.25) +
    (features.capital * 0.25)
  );
  
  // SAID component (40%)
  const said = saidScore || 0;
  
  // Base score: 60% FairScale, 40% SAID
  let score = (fairscaleScore * 0.60) + (said * 0.40);
  
  // SAID verified bonus: +10 points
  if (saidVerified) {
    score += 10;
  }
  
  return Math.min(Math.round(score), 100);
}

function calculateSocialCombined(fairscaleSocial, saidData) {
  const fsScore = (fairscaleSocial || 0) / 100;
  const hasSAIDSocial = (saidData?.identity?.twitter || saidData?.identity?.website) ? 1 : 0;
  
  return Math.round(((fsScore * 0.5) + (hasSAIDSocial * 0.5)) * 100);
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale Reputation API',
    version: '4.0.0',
    status: 'ok',
    endpoints: {
      'GET /score': 'Full reputation score',
      'GET /check': 'Quick trust scores'
    },
    docs: 'https://docs.fairscale.xyz'
  });
});

app.get('/score', async (req, res) => {
  const wallet = req.query.wallet;
  
  if (!wallet) {
    return res.status(400).json({ 
      error: 'Missing wallet parameter',
      usage: 'GET /score?wallet=ADDRESS'
    });
  }
  
  // Fetch both in parallel
  const [fairscaleData, saidData] = await Promise.all([
    getFairScaleScore(wallet),
    getSAIDScore(wallet)
  ]);
  
  if (!fairscaleData) {
    return res.status(500).json({ 
      error: 'Failed to fetch score',
      wallet 
    });
  }
  
  // Calculate features
  const features = calculateFeatures(fairscaleData);
  
  // Calculate badges
  const badges = calculateBadges(fairscaleData, saidData);
  
  // Get SAID score (0-100)
  const saidScore = saidData?.reputation?.score || 0;
  
  // Calculate social combined
  const socialCombined = calculateSocialCombined(fairscaleData.social_score, saidData);
  
  // Calculate agent score
  const agentScore = calculateAgentScore(features, socialCombined, saidScore, saidData?.verified);
  
  // Calculate trust scores
  const trust = calculateTrustScores(features, saidScore);
  
  // Build social object
  const social = {
    fairscale: fairscaleData.social_score || null,
    said: !!(saidData?.identity?.twitter || saidData?.identity?.website)
  };
  
  // Build SAID object
  const said = saidData ? {
    registered: saidData.registered || false,
    verified: saidData.verified || false,
    name: saidData.identity?.name || null,
    score: saidData.reputation?.score || null,
    trust_tier: saidData.reputation?.trustTier || null,
    skills: saidData.skills || []
  } : {
    registered: false,
    verified: false,
    name: null,
    score: null,
    trust_tier: null,
    skills: []
  };
  
  return res.json({
    wallet,
    fairscale_agent_score: agentScore,
    trust,
    badges,
    features,
    social,
    said
  });
});

app.get('/check', async (req, res) => {
  const { wallet } = req.query;
  
  if (!wallet) {
    return res.status(400).json({ 
      error: 'Missing wallet parameter',
      usage: 'GET /check?wallet=ADDRESS'
    });
  }
  
  // Fetch both in parallel
  const [fairscaleData, saidData] = await Promise.all([
    getFairScaleScore(wallet),
    getSAIDScore(wallet)
  ]);
  
  if (!fairscaleData) {
    return res.status(500).json({ error: 'Failed to fetch score' });
  }
  
  // Calculate features
  const features = calculateFeatures(fairscaleData);
  
  // Get SAID score
  const saidScore = saidData?.reputation?.score || 0;
  
  // Calculate social combined
  const socialCombined = calculateSocialCombined(fairscaleData.social_score, saidData);
  
  // Calculate agent score
  const agentScore = calculateAgentScore(features, socialCombined, saidScore, saidData?.verified);
  
  // Calculate trust scores
  const trust = calculateTrustScores(features, saidScore);
  
  return res.json({
    wallet,
    fairscale_agent_score: agentScore,
    trust,
    said_verified: saidData?.verified || false
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    endpoints: {
      'GET /': 'API info',
      'GET /score': 'Full reputation score',
      'GET /check': 'Quick trust scores'
    }
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(CONFIG.PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         FairScale Reputation API v4.0                 ║
╠═══════════════════════════════════════════════════════╣
║  Port: ${CONFIG.PORT}                                          ║
║                                                       ║
║  Endpoints:                                           ║
║    GET /score   Full reputation score                 ║
║    GET /check   Quick trust scores                    ║
║                                                       ║
║  Sources: FairScale + SAID                            ║
╚═══════════════════════════════════════════════════════╝
  `);
});
