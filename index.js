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
  
  // Values from FairScale are already 0-100 percentiles
  // Exception: no_instant_dumps is 0-1
  
  // Longevity: Wallet age + Active days
  const ageScore = f.wallet_age_score || 0;
  const activeScore = f.active_days || 0;
  const longevity = Math.round((ageScore + activeScore) / 2);
  
  // Experience: Transaction count + Platform diversity
  const txScore = f.tx_count || 0;
  const diversityScore = f.platform_diversity || 0;
  const experience = Math.round((txScore + diversityScore) / 2);
  
  // Conviction: Conviction ratio + Hold days + No dumps (scaled)
  const convictionRatio = f.conviction_ratio || 0;
  const holdScore = f.median_hold_days || 0;
  const noDumps = (f.no_instant_dumps || 0) * 100; // Scale 0-1 to 0-100
  const conviction = Math.round((convictionRatio + holdScore + noDumps) / 3);
  
  // Capital: Major holdings + Stablecoins
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

function buildInfo(fairscaleData, saidData, features) {
  const info = {
    description: null,
    skills: [],
    actions: [],
    highlights: [],
    tier: null
  };
  
  // From SAID
  if (saidData?.identity?.description) {
    info.description = saidData.identity.description;
  }
  
  if (saidData?.skills?.length > 0) {
    info.skills = saidData.skills;
  }
  
  // From FairScale
  if (fairscaleData.tier) {
    info.tier = fairscaleData.tier;
  }
  
  if (fairscaleData.actions?.length > 0) {
    info.actions = fairscaleData.actions.map(a => ({
      id: a.id,
      label: a.label,
      description: a.description,
      priority: a.priority
    }));
  }
  
  // Generate highlights based on features
  const highlights = [];
  
  if (features.longevity >= 70) {
    highlights.push('Established wallet with consistent activity');
  } else if (features.longevity >= 40) {
    highlights.push('Moderately active wallet');
  } else if (features.longevity < 20) {
    highlights.push('New or inactive wallet');
  }
  
  if (features.experience >= 70) {
    highlights.push('Highly experienced across multiple protocols');
  } else if (features.experience >= 40) {
    highlights.push('Moderate transaction history');
  }
  
  if (features.conviction >= 80) {
    highlights.push('Strong holder with diamond hands');
  } else if (features.conviction >= 50) {
    highlights.push('Shows holding conviction');
  }
  
  if (features.capital >= 70) {
    highlights.push('Well-capitalised wallet');
  } else if (features.capital >= 40) {
    highlights.push('Moderate holdings');
  } else if (features.capital < 20) {
    highlights.push('Low capital base');
  }
  
  if (saidData?.verified) {
    highlights.push('SAID verified identity');
  }
  
  if (saidData?.reputation?.trustTier === 'high') {
    highlights.push('High trust tier on SAID');
  }
  
  info.highlights = highlights;
  
  return info;
}

function calculateBadges(data, saidData) {
  const f = data.features || {};
  const badges = [];
  
  // Established: High wallet age score
  if ((f.wallet_age_score || 0) >= 70) {
    badges.push({ id: 'established', label: 'Established' });
  }
  
  // Committed: High conviction ratio
  if ((f.conviction_ratio || 0) >= 70) {
    badges.push({ id: 'committed', label: 'Committed' });
  }
  
  // Capitalised: High holdings
  if ((f.major_percentile_score || 0) >= 70) {
    badges.push({ id: 'capitalised', label: 'Capitalised' });
  }
  
  // Diverse: Uses many protocols
  if ((f.platform_diversity || 0) >= 60) {
    badges.push({ id: 'diverse', label: 'Diverse' });
  }
  
  // Experienced: High transaction count percentile
  if ((f.tx_count || 0) >= 70) {
    badges.push({ id: 'experienced', label: 'Experienced' });
  }
  
  // Holder: Long hold times
  if ((f.median_hold_days || 0) >= 70) {
    badges.push({ id: 'holder', label: 'Holder' });
  }
  
  // Net Positive: Adding capital
  if ((f.net_sol_flow_30d || 0) > 50) {
    badges.push({ id: 'net_positive', label: 'Net Positive' });
  }
  
  // Staker: Active staker
  if ((f.lst_percentile_score || 0) >= 50) {
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
  
  // Build info section
  const info = buildInfo(fairscaleData, saidData, features);
  
  return res.json({
    wallet,
    agent_fairscore: agentScore,
    fairscore_base: Math.round(fairscaleData.fairscore || 0),
    badges,
    features,
    info,
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
    agent_fairscore: agentScore,
    fairscore_base: Math.round(fairscaleData.fairscore || 0),
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
