// server.js - Multi-User Twitch Giveaway Service
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Your Twitch Application Credentials (set these in environment variables)
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'YOUR_TWITCH_CLIENT_ID';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || 'YOUR_TWITCH_CLIENT_SECRET';
const WEBHOOK_SECRET = process.env.TWITCH_WEBHOOK_SECRET || 'your-webhook-secret-123';
const NODE_ENV = process.env.NODE_ENV || 'development';

// In-memory storage (use Redis/Database in production)
const userSessions = new Map(); // userId -> {accessToken, refreshToken, rewardId, subscriptionId}
const userConnections = new Map(); // userId -> Set of SSE connections
const activeGiveaways = new Map(); // userId -> {isActive, entries, rewardId}

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "https://api.twitch.tv", "https://id.twitch.tv"],
            imgSrc: ["'self'", "data:", "https:", "https://static-cdn.jtvnw.net"],
        },
    },
}));

app.use(cors({
    origin: true,
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later.'
});
app.use('/api', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Inject client ID into frontend
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let indexHtml = require('fs').readFileSync(indexPath, 'utf8');
    
    // Replace placeholder with actual client ID
    indexHtml = indexHtml.replace('YOUR_APP_CLIENT_ID', TWITCH_CLIENT_ID);
    
    res.send(indexHtml);
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeUsers: userSessions.size,
        activeGiveaways: Array.from(activeGiveaways.values()).filter(g => g.isActive).length,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// OAuth token exchange
app.post('/api/oauth/exchange', async (req, res) => {
    try {
        const { code, redirect_uri } = req.body;
        
        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' });
        }
        
        // Exchange code for tokens
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: redirect_uri
            })
        });
        
        if (!tokenResponse.ok) {
            throw new Error('Token exchange failed');
        }
        
        const tokenData = await tokenResponse.json();
        
        // Get user info
        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });
        
        const userData = await userResponse.json();
        const userId = userData.data[0].id;
        
        // Store session
        userSessions.set(userId, {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            userInfo: userData.data[0],
            createdAt: new Date()
        });
        
        console.log(`User authenticated: ${userData.data[0].display_name} (${userId})`);
        
        res.json({
            access_token: tokenData.access_token,
            user_id: userId
        });
        
    } catch (error) {
        console.error('OAuth exchange error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Create channel points reward
app.post('/api/rewards/create', async (req, res) => {
    try {
        const { title, cost, prompt, user_id, access_token } = req.body;
        
        const session = userSessions.get(user_id);
        if (!session || session.accessToken !== access_token) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        
        // Create reward via Twitch API
        const rewardResponse = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${user_id}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Client-Id': TWITCH_CLIENT_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title,
                cost: cost,
                prompt: prompt,
                is_enabled: false,
                background_color: '#9146FF',
                is_user_input_required: false,
                is_max_per_stream_enabled: false,
                is_max_per_user_per_stream_enabled: true,
                max_per_user_per_stream: 1,
                should_redemptions_skip_request_queue: true
            })
        });
        
        if (!rewardResponse.ok) {
            const error = await rewardResponse.text();
            throw new Error(`Reward creation failed: ${error}`);
        }
        
        const rewardData = await rewardResponse.json();
        const rewardId = rewardData.data[0].id;
        
        // Update session with reward ID
        session.rewardId = rewardId;
        
        // Initialize giveaway state
        activeGiveaways.set(user_id, {
            isActive: false,
            entries: [],
            rewardId: rewardId,
            createdAt: new Date()
        });
        
        console.log(`Reward created for ${session.userInfo.display_name}: ${title} (${cost} points)`);
        
        res.json({
            success: true,
            reward_id: rewardId,
            reward_data: rewardData.data[0]
        });
        
    } catch (error) {
        console.error('Reward creation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Setup EventSub webhook subscription
app.post('/api/webhooks/subscribe', async (req, res) => {
    try {
        const { user_id, reward_id, access_token } = req.body;
        
        const session = userSessions.get(user_id);
        if (!session || session.accessToken !== access_token) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        
        const webhookUrl = `${req.protocol}://${req.get('host')}/webhook/eventsub`;
        
        // Create EventSub subscription
        const subscriptionResponse = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Client-Id': TWITCH_CLIENT_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'channel.channel_points_custom_reward_redemption.add',
                version: '1',
                condition: {
                    broadcaster_user_id: user_id,
                    reward_id: reward_id
                },
                transport: {
                    method: 'webhook',
                    callback: webhookUrl,
                    secret: WEBHOOK_SECRET
                }
            })
        });
        
        if (!subscriptionResponse.ok) {
            const error = await subscriptionResponse.text();
            throw new Error(`Subscription failed: ${error}`);
        }
        
        const subscriptionData = await subscriptionResponse.json();
        session.subscriptionId = subscriptionData.data[0].id;
        
        console.log(`EventSub subscription created for ${session.userInfo.display_name}`);
        
        res.json({
            success: true,
            subscription_id: subscriptionData.data[0].id
        });
        
    } catch (error) {
        console.error('Webhook subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enable/disable channel points reward
app.post('/api/rewards/:action', async (req, res) => {
    try {
        const { action } = req.params; // 'enable' or 'disable'
        const { user_id, reward_id, access_token } = req.body;
        
        const session = userSessions.get(user_id);
        if (!session || session.accessToken !== access_token) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        
        const isEnabled = action === 'enable';
        
        // Update reward status
        const response = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${user_id}&id=${reward_id}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Client-Id': TWITCH_CLIENT_ID,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                is_enabled: isEnabled,
                is_paused: !isEnabled
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to update reward status');
        }
        
        // Update giveaway state
        const giveaway = activeGiveaways.get(user_id);
        if (giveaway) {
            giveaway.isActive = isEnabled;
        }
        
        console.log(`Giveaway ${isEnabled ? 'started' : 'stopped'} for ${session.userInfo.display_name}`);
        
        res.json({ success: true, enabled: isEnabled });
        
    } catch (error) {
        console.error('Reward update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Server-Sent Events for real-time updates
app.get('/events/:userId', (req, res) => {
    const userId = req.params.userId;
    
    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    // Add connection to user's connection set
    if (!userConnections.has(userId)) {
        userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(res);
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({
        type: 'connection_status',
        status: 'connected',
        timestamp: new Date().toISOString()
    })}\n\n`);
    
    // Handle client disconnect
    req.on('close', () => {
        const connections = userConnections.get(userId);
        if (connections) {
            connections.delete(res);
            if (connections.size === 0) {
                userConnections.delete(userId);
            }
        }
    });
    
    // Keep-alive heartbeat
    const heartbeat = setInterval(() => {
        try {
            res.write(`data: ${JSON.stringify({
                type: 'heartbeat',
                timestamp: new Date().toISOString()
            })}\n\n`);
        } catch (error) {
            clearInterval(heartbeat);
        }
    }, 30000);
    
    req.on('close', () => clearInterval(heartbeat));
});

// Broadcast message to specific user's connections
function broadcastToUser(userId, eventData) {
    const connections = userConnections.get(userId);
    if (!connections) return;
    
    const message = `data: ${JSON.stringify(eventData)}\n\n`;
    const deadConnections = [];
    
    for (const connection of connections) {
        try {
            connection.write(message);
        } catch (error) {
            deadConnections.push(connection);
        }
    }
    
    // Remove dead connections
    deadConnections.forEach(conn => connections.delete(conn));
}

// Twitch EventSub webhook endpoint
app.post('/webhook/eventsub', (req, res) => {
    // Verify webhook signature
    const messageId = req.header('Twitch-Eventsub-Message-Id');
    const timestamp = req.header('Twitch-Eventsub-Message-Timestamp');
    const signature = req.header('Twitch-Eventsub-Message-Signature');
    const messageType = req.header('Twitch-Eventsub-Message-Type');
    
    if (!messageId || !timestamp || !signature) {
        return res.status(400).send('Missing required headers');
    }
    
    // Verify signature
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(messageId + timestamp + req.body)
        .digest('hex');
    
    if (`sha256=${expectedSignature}` !== signature) {
        console.log('Invalid webhook signature');
        return res.status(403).send('Invalid signature');
    }
    
    let event;
    try {
        event = JSON.parse(req.body);
    } catch (error) {
        return res.status(400).send('Invalid JSON');
    }
    
    // Handle different message types
    switch (messageType) {
        case 'webhook_callback_verification':
            console.log('Webhook verification for challenge:', event.challenge);
            return res.status(200).send(event.challenge);
            
        case 'notification':
            handleEventNotification(event);
            break;
            
        case 'revocation':
            handleSubscriptionRevocation(event);
            break;
    }
    
    res.status(200).send('OK');
});

// Handle EventSub notifications
function handleEventNotification(event) {
    const eventData = event.event;
    const subscriptionType = event.subscription.type;
    
    if (subscriptionType === 'channel.channel_points_custom_reward_redemption.add') {
        const userId = eventData.broadcaster_user_id;
        const giveaway = activeGiveaways.get(userId);
        const session = userSessions.get(userId);
        
        if (!giveaway || !session) {
            console.log(`No active giveaway found for user ${userId}`);
            return;
        }
        
        // Check if this is for the current giveaway reward
        if (eventData.reward.id !== giveaway.rewardId) {
            console.log(`Redemption for different reward: ${eventData.reward.id}`);
            return;
        }
        
        // Add entry to giveaway
        const entry = {
            username: eventData.user_name,
            user_id: eventData.user_id,
            redemption_id: eventData.id,
            reward_id: eventData.reward.id,
            reward_cost: eventData.reward.cost,
            redeemed_at: eventData.redeemed_at
        };
        
        giveaway.entries.push(entry);
        
        // Broadcast to user's frontend
        broadcastToUser(userId, {
            type: 'giveaway_entry',
            ...entry
        });
        
        console.log(`New giveaway entry for ${session.userInfo.display_name}: ${eventData.user_name}`);
    }
}

// Handle subscription revocations
function handleSubscriptionRevocation(event) {
    console.log('Subscription revoked:', event.subscription.id);
    
    // Find user with this subscription and notify them
    for (const [userId, session] of userSessions) {
        if (session.subscriptionId === event.subscription.id) {
            broadcastToUser(userId, {
                type: 'subscription_revoked',
                reason: event.subscription.status
            });
            break;
        }
    }
}

// Get giveaway stats
app.get('/api/giveaway/:userId/stats', (req, res) => {
    const userId = req.params.userId;
    const giveaway = activeGiveaways.get(userId);
    
    if (!giveaway) {
        return res.status(404).json({ error: 'Giveaway not found' });
    }
    
    const uniqueUsers = new Set(giveaway.entries.map(e => e.username));
    const totalPoints = giveaway.entries.reduce((sum, e) => sum + (e.reward_cost || 0), 0);
    
    res.json({
        isActive: giveaway.isActive,
        totalEntries: giveaway.entries.length,
        uniqueUsers: uniqueUsers.size,
        totalPointsSpent: totalPoints,
        entries: giveaway.entries.slice(-20) // Last 20 entries
    });
});

// Global stats endpoint
app.get('/api/stats', (req, res) => {
    const totalUsers = userSessions.size;
    const activeGiveawaysCount = Array.from(activeGiveaways.values()).filter(g => g.isActive).length;
    const totalEntries = Array.from(activeGiveaways.values()).reduce((sum, g) => sum + g.entries.length, 0);
    
    res.json({
        totalUsers,
        activeGiveaways: activeGiveawaysCount,
        totalEntries,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Cleanup endpoint (for testing)
if (NODE_ENV === 'development') {
    app.post('/api/cleanup/:userId', (req, res) => {
        const userId = req.params.userId;
        
        userSessions.delete(userId);
        activeGiveaways.delete(userId);
        userConnections.delete(userId);
        
        res.json({ success: true, message: 'User data cleaned up' });
    });
}

// Error handling
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🎉 Multi-User Twitch Giveaway Service Started!
┌─────────────────────────────────────────────┐
│  Port: ${PORT}                                    │
│  Environment: ${NODE_ENV}                        │  
│  Twitch Client ID: ${TWITCH_CLIENT_ID.substring(0, 8)}...         │
│  Frontend: /                                │
│  Health: /health                            │
└─────────────────────────────────────────────┘
    `);
    
    if (NODE_ENV === 'development') {
        console.log(`🌐 Local URL: http://localhost:${PORT}`);
    }
});

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
    console.log('🛑 Shutting down gracefully...');
    
    // Notify all connected users
    for (const [userId, connections] of userConnections) {
        const message = `data: ${JSON.stringify({
            type: 'server_shutdown',
            message: 'Server is restarting, please refresh the page'
        })}\n\n`;
        
        for (const connection of connections) {
            try {
                connection.write(message);
                connection.end();
            } catch (error) {
                // Connection already closed
            }
        }
    }
    
    server.close((err) => {
        if (err) {
            console.error('Error during shutdown:', err);
            process.exit(1);
        }
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
}

module.exports = app;
