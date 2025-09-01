// server.js - Enhanced Twitch EventSub Webhook Server with Static File Serving
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const WEBHOOK_SECRET = process.env.TWITCH_WEBHOOK_SECRET || 'your-webhook-secret-123';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "https://api.twitch.tv", "https://id.twitch.tv"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
}));

// CORS configuration
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        
        if (ALLOWED_ORIGINS.some(allowedOrigin => 
            origin.includes(allowedOrigin.replace(/^https?:\/\//, '')))) {
            return callback(null, true);
        }
        
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.RATE_LIMIT_MAX || 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '1d' : '0',
    etag: true,
    lastModified: true
}));

// Raw body parser for webhook signature verification
app.use('/webhook', express.raw({
    type: 'application/json',
    limit: '1mb'
}));

// JSON parser for other routes
app.use(express.json({ limit: '10mb' }));

// Store active connections (in production, consider Redis)
const activeConnections = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Twitch EventSub Webhook Server',
        timestamp: new Date().toISOString(),
        activeConnections: activeConnections.size,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.env.npm_package_version || '1.0.0'
    });
});

// Main route - serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server-Sent Events endpoint for real-time communication
app.get('/events', (req, res) => {
    // Set up Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
        'X-Accel-Buffering': 'no' // Disable Nginx buffering
    });

    const connectionId = Date.now() + Math.random();
    const clientInfo = {
        connection: res,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        connectedAt: new Date()
    };
    
    activeConnections.set(connectionId, clientInfo);

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
        try {
            res.write(`data: ${JSON.stringify({
                type: 'heartbeat',
                timestamp: new Date().toISOString(),
                connectionId: connectionId
            })}\n\n`);
        } catch (error) {
            clearInterval(heartbeat);
            activeConnections.delete(connectionId);
        }
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        activeConnections.delete(connectionId);
        console.log(`Client ${connectionId} disconnected`);
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({
        type: 'connected',
        message: 'Connected to EventSub server',
        connectionId: connectionId,
        serverTime: new Date().toISOString()
    })}\n\n`);
});

// Broadcast event to all connected clients
function broadcastEvent(eventData) {
    const message = `data: ${JSON.stringify({
        ...eventData,
        serverTime: new Date().toISOString()
    })}\n\n`;
    
    const disconnectedClients = [];
    
    for (const [connectionId, clientInfo] of activeConnections) {
        try {
            clientInfo.connection.write(message);
        } catch (error) {
            console.log('Removing dead connection:', connectionId);
            disconnectedClients.push(connectionId);
        }
    }
    
    // Clean up dead connections
    disconnectedClients.forEach(id => activeConnections.delete(id));
}

// Twitch EventSub webhook endpoint
app.post('/webhook/eventsub', (req, res) => {
    const startTime = Date.now();
    
    // Get Twitch headers
    const messageId = req.header('Twitch-Eventsub-Message-Id');
    const timestamp = req.header('Twitch-Eventsub-Message-Timestamp');
    const signature = req.header('Twitch-Eventsub-Message-Signature');
    const messageType = req.header('Twitch-Eventsub-Message-Type');
    const subscriptionType = req.header('Twitch-Eventsub-Subscription-Type');

    console.log(`[${new Date().toISOString()}] Webhook received:`, {
        messageType,
        subscriptionType,
        messageId: messageId?.substring(0, 8) + '...'
    });

    if (!messageId || !timestamp || !signature) {
        console.log('Missing required headers');
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Missing required headers'
        });
    }

    // Verify webhook signature
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(messageId + timestamp + req.body)
        .digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    if (expectedSignature !== providedSignature) {
        console.log('Invalid signature - possible security breach attempt');
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Invalid signature'
        });
    }

    let event;
    try {
        event = JSON.parse(req.body);
    } catch (error) {
        console.log('Invalid JSON payload');
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid JSON payload'
        });
    }

    // Handle different message types
    switch (messageType) {
        case 'webhook_callback_verification':
            console.log('Webhook verification challenge received');
            return res.status(200).send(event.challenge);

        case 'notification':
            handleEventNotification(event);
            break;

        case 'revocation':
            console.log('Subscription revoked:', event.subscription.id, 'Reason:', event.subscription.status);
            broadcastEvent({
                type: 'subscription_revoked',
                subscription_id: event.subscription.id,
                reason: event.subscription.status
            });
            break;

        default:
            console.log('Unknown message type:', messageType);
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Unknown message type'
            });
    }

    const processingTime = Date.now() - startTime;
    console.log(`Webhook processed in ${processingTime}ms`);
    
    res.status(200).json({
        status: 'success',
        processingTime: processingTime
    });
});

// Handle EventSub notifications
function handleEventNotification(event) {
    const subscriptionType = event.subscription.type;
    const eventData = event.event;

    console.log(`Processing ${subscriptionType} event for user: ${eventData.user_name || eventData.user_login || 'unknown'}`);

    switch (subscriptionType) {
        case 'channel.channel_points_custom_reward_redemption.add':
            handleChannelPointsRedemption(eventData);
            break;

        case 'channel.channel_points_custom_reward_redemption.update':
            handleChannelPointsRedemptionUpdate(eventData);
            break;

        case 'channel.follow':
            handleFollowEvent(eventData);
            break;

        case 'channel.subscribe':
            handleSubscriptionEvent(eventData);
            break;

        default:
            console.log('Unhandled subscription type:', subscriptionType);
            broadcastEvent({
                type: 'unhandled_event',
                subscription_type: subscriptionType,
                event_data: eventData
            });
    }
}

// Handle channel points redemption
function handleChannelPointsRedemption(redemptionData) {
    const entryData = {
        type: 'giveaway_entry',
        username: redemptionData.user_name,
        user_id: redemptionData.user_id,
        reward_id: redemptionData.reward.id,
        reward_title: redemptionData.reward.title,
        reward_cost: redemptionData.reward.cost,
        redeemed_at: redemptionData.redeemed_at,
        redemption_id: redemptionData.id,
        user_input: redemptionData.user_input || null,
        status: redemptionData.status
    };

    // Broadcast to all connected clients
    broadcastEvent(entryData);

    console.log(`✅ Giveaway entry: ${entryData.username} (${entryData.reward_cost} points) - ${entryData.reward_title}`);
}

// Handle redemption updates (fulfilled, canceled, etc.)
function handleChannelPointsRedemptionUpdate(redemptionData) {
    const updateData = {
        type: 'redemption_update',
        username: redemptionData.user_name,
        user_id: redemptionData.user_id,
        redemption_id: redemptionData.id,
        reward_title: redemptionData.reward.title,
        status: redemptionData.status,
        updated_at: redemptionData.redeemed_at
    };

    broadcastEvent(updateData);
    console.log(`📝 Redemption updated: ${updateData.username} - ${updateData.status}`);
}

// Handle follow events (bonus feature)
function handleFollowEvent(eventData) {
    broadcastEvent({
        type: 'new_follow',
        username: eventData.user_name,
        user_id: eventData.user_id,
        followed_at: eventData.followed_at
    });
    
    console.log(`💜 New follower: ${eventData.user_name}`);
}

// Handle subscription events (bonus feature)  
function handleSubscriptionEvent(eventData) {
    broadcastEvent({
        type: 'new_subscription',
        username: eventData.user_name,
        user_id: eventData.user_id,
        tier: eventData.tier,
        is_gift: eventData.is_gift,
        subscribed_at: eventData.subscribed_at || new Date().toISOString()
    });
    
    console.log(`⭐ New subscriber: ${eventData.user_name} (Tier ${eventData.tier})`);
}

// API endpoint to get server stats
app.get('/api/stats', (req, res) => {
    const connections = Array.from(activeConnections.entries()).map(([id, info]) => ({
        id: id,
        ip: info.ip,
        connectedAt: info.connectedAt,
        userAgent: info.userAgent?.substring(0, 100) || 'unknown'
    }));

    res.json({
        server: {
            status: 'running',
            uptime: process.uptime(),
            startTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            version: process.env.npm_package_version || '1.0.0',
            nodeVersion: process.version,
            environment: NODE_ENV
        },
        connections: {
            active: activeConnections.size,
            details: connections
        },
        resources: {
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
        },
        timestamp: new Date().toISOString()
    });
});

// API endpoint to test webhook connectivity
app.post('/api/test-webhook', (req, res) => {
    if (NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'Test endpoint disabled in production'
        });
    }

    const testEvent = {
        type: 'test_entry',
        username: 'TestUser' + Math.floor(Math.random() * 1000),
        user_id: '12345',
        reward_cost: 100,
        reward_title: 'Test Giveaway Entry',
        redeemed_at: new Date().toISOString(),
        redemption_id: 'test-' + Date.now()
    };

    broadcastEvent(testEvent);
    res.json({ 
        success: true, 
        message: 'Test event broadcasted',
        testEvent 
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Server error:`, error);
    
    res.status(500).json({
        error: 'Internal server error',
        message: NODE_ENV === 'development' ? error.message : 'Something went wrong',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
        message: 'The requested resource was not found',
        timestamp: new Date().toISOString()
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Twitch EventSub Webhook Server Started!
┌─────────────────────────────────────────┐
│  Port: ${PORT}                               │
│  Environment: ${NODE_ENV}                   │
│  Webhook URL: /webhook/eventsub         │
│  Events Stream: /events                 │  
│  Frontend: /                            │
│  Health Check: /health                  │
│  Stats API: /api/stats                  │
└─────────────────────────────────────────┘
    `);
    
    if (NODE_ENV === 'development') {
        console.log(`🌐 Local URLs:`);
        console.log(`   Frontend: http://localhost:${PORT}`);
        console.log(`   Webhook: http://localhost:${PORT}/webhook/eventsub`);
        console.log(`   ⚠️  For production webhooks, ensure HTTPS!`);
    }
});

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown(signal) {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    
    // Close all active SSE connections
    const shutdownMessage = JSON.stringify({
        type: 'server_shutdown',
        message: 'Server is shutting down',
        timestamp: new Date().toISOString()
    });
    
    for (const [connectionId, clientInfo] of activeConnections) {
        try {
            clientInfo.connection.write(`data: ${shutdownMessage}\n\n`);
            clientInfo.connection.end();
        } catch (error) {
            // Connection already closed
        }
    }
    
    // Close HTTP server
    server.close((err) => {
        if (err) {
            console.error('Error during server shutdown:', err);
            process.exit(1);
        }
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.log('❌ Force closing server');
        process.exit(1);
    }, 10000);
}

module.exports = app;
