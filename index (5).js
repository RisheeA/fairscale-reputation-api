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
  PORT: process.env.PORT || 3000,
  
  WEIGHTS: {
    fairscale: 0.7,
    said: 0.3
  }
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
// SCORE CALCULATIONS
// =============================================================================

function calculateFeatures(data) {
  const features = data.features || {};
  
  // Economy: Holdings strength (major tokens + stablecoins)
  const majorScore = (features.major_percentile_score || 0) * 100;
  const stableScore = (features.stable_percentile_score || 0) * 100;
  const economy = Math.round((majorScore * 0.6) + (stableScore * 0.4));
  
  // Consistency: Regular activity over time
  const activeDays = features.active_days || 0;
  const walletAge = features.wallet_age_days || 1;
  const activityRatio = Math.min(activeDays / walletAge, 1);
  const consistency = Math.round(activityRatio * 100);
  
  return {
    economy: Math.min(economy, 100),
    consistency: Math.min(consistency, 100)
  };
}

function calculateTrust(data, features) {
  const baseScore = data.fairscore || 0;
  const walletAge = data.features?.wallet_age_days || 0;
  
  // Lending: Economy heavy (do they have assets to back loans?)
  const lending = Math.round(
    (baseScore * 0.4) +
    (features.economy * 0.4) +
    (features.consistency * 0.2)
  );
  
  // OTC: Consistency + age heavy (are they reliable over time?)
  const ageScore = Math.min((walletAge / 365) * 100, 100);
  const otc = Math.round(
    (baseScore * 0.3) +
    (features.consistency * 0.4) +
    (ageScore * 0.3)
  );
  
  return {
    lending: Math.min(lending, 100),
    otc: Math.min(otc, 100)
  };
}

function calculateCombinedScore(fairscaleScore, saidReputation) {
  if (!saidReputation) {
    return Math.round(fairscaleScore);
  }
  
  // SAID is 0-10000 basis points, convert to 0-100
  const saidNormalized = (saidReputation / 10000) * 100;
  
  const combined = 
    (fairscaleScore * CONFIG.WEIGHTS.fairscale) +
    (saidNormalized * CONFIG.WEIGHTS.said);
  
  return Math.round(combined);
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
      'GET /check': 'Quick risk assessment'
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
  
  // Calculate
  const features = calculateFeatures(fairscaleData);
  const trust = calculateTrust(fairscaleData, features);
  
  // SAID data
  const said = saidData ? {
    registered: saidData.registered || false,
    verified: saidData.verified || false,
    reputation: saidData.reputation ? Math.round(saidData.reputation / 100) : null
  } : {
    registered: false,
    verified: false,
    reputation: null
  };
  
  // Combined score
  const reputationScore = calculateCombinedScore(
    fairscaleData.fairscore || 0,
    saidData?.reputation || null
  );
  
  return res.json({
    wallet,
    reputation_score: reputationScore,
    
    fairscale: {
      score: Math.round(fairscaleData.fairscore || 0),
      features,
      trust,
      social: fairscaleData.social_score || null
    },
    
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
  
  const features = calculateFeatures(fairscaleData);
  const trust = calculateTrust(fairscaleData, features);
  
  const said = saidData ? {
    registered: saidData.registered || false,
    verified: saidData.verified || false,
    reputation: saidData.reputation ? Math.round(saidData.reputation / 100) : null
  } : {
    registered: false,
    verified: false,
    reputation: null
  };
  
  const reputationScore = calculateCombinedScore(
    fairscaleData.fairscore || 0,
    saidData?.reputation || null
  );
  
  return res.json({
    wallet,
    reputation_score: reputationScore,
    fairscale_score: Math.round(fairscaleData.fairscore || 0),
    trust,
    said_verified: said.verified
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
║    GET /check   Quick risk assessment                 ║
║                                                       ║
║  Sources:                                             ║
║    FairScale (70%) + SAID (30%)                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});
