# Twitch Channel Points Giveaway System

A complete production-ready system for managing Twitch channel points giveaways with real-time EventSub webhooks and OAuth integration.

## 🌟 Features

- **OAuth Authentication** with Twitch
- **Real-time EventSub Webhooks** for channel point redemptions  
- **Automatic Giveaway Management** with live entry tracking
- **Winner Selection** with dramatic announcements
- **Production-ready Webhook Server** with HTTPS
- **Free Hosting** on Render with automatic deployments

## 🚀 Quick Deploy

### For Streamers (Easy Setup):

1. **Fork this repository** to your GitHub account
2. **Go to [Render](https://render.com)** and sign up with GitHub
3. **Create New Web Service** → Connect your forked repository
4. **Set Environment Variables** (see below)
5. **Deploy!** Your webhook server will be live with HTTPS

### For Developers:

```bash
git clone https://github.com/yourusername/twitch-giveaway-system
cd twitch-giveaway-system
npm install
npm run dev
```

## ⚙️ Configuration

### 1. Create Twitch Application

1. Go to [Twitch Developer Console](https://dev.twitch.tv/console)
2. Click "Register Your Application"
3. Fill in:
   - **Name**: Your Giveaway App
   - **OAuth Redirect URLs**: `https://your-frontend-url.com/callback`
   - **Category**: Application Integration
4. Save your **Client ID** and **Client Secret**

### 2. Environment Variables (Render Dashboard)

Set these in your Render service environment variables:

```env
TWITCH_WEBHOOK_SECRET=your-super-secret-webhook-key-123
TWITCH_CLIENT_SECRET=your-twitch-client-secret-from-step-1
ALLOWED_ORIGINS=https://your-frontend-domain.com,http://localhost:8080
NODE_ENV=production
```

### 3. Update Frontend Configuration

In `public/index.html`, update line 892:
```javascript
const webhookServerUrl = 'https://your-render-app.onrender.com';
```

## 📁 Repository Structure

```
twitch-giveaway-system/
├── server.js                 # Main webhook server
├── public/
│   └── index.html            # Frontend giveaway interface
├── package.json              # Dependencies and scripts
├── render.yaml               # Render deployment config
├── .env.example              # Environment variables template
├── README.md                 # This file
├── docs/                     # Documentation
│   ├── setup-guide.md       # Detailed setup instructions
│   ├── api-reference.md     # API documentation
│   └── troubleshooting.md   # Common issues and solutions
└── tests/
    └── webhook-test.js       # Test webhook functionality
```

## 🔧 Local Development

1. **Clone and Install**:
```bash
git clone https://github.com/yourusername/twitch-giveaway-system
cd twitch-giveaway-system
npm install
```

2. **Set up environment**:
```bash
cp .env.example .env
# Edit .env with your Twitch app credentials
```

3. **Run development server**:
```bash
npm run dev
```

4. **Open frontend**: `http://localhost:3000`

## 🌐 Production Deployment

### Render (Recommended - Free)

1. **Fork this repo** to your GitHub
2. **Connect to Render**:
   - Go to [render.com](https://render.com)
   - "New" → "Web Service"
   - Connect your GitHub repo
   - Render will auto-detect settings from `render.yaml`
3. **Set Environment Variables** in Render dashboard
4. **Deploy!** - Gets automatic HTTPS URL

### Alternative Platforms

- **Railway**: `railway init && railway deploy`
- **Vercel**: `vercel --prod` 
- **Heroku**: `git push heroku main`

## 📋 Usage Instructions

### For Streamers:

1. **Go to your deployed frontend URL**
2. **Enter your Twitch credentials** (Client ID, etc.)
3. **Click "Authorize with Twitch"** → Complete OAuth
4. **Click "Connect & Setup"** → Creates channel points reward
5. **Start Giveaway** → Viewers can redeem points to enter!
6. **Draw Winner** when ready

### For Developers:

The system provides several API endpoints:
- `GET /` - Health check
- `POST /webhook/eventsub` - Twitch EventSub endpoint
- `GET /events` - Server-Sent Events stream
- `GET /api/stats` - Server statistics

## 🔒 Security Features

- **Webhook signature verification** prevents fake events
- **CORS protection** limits access to allowed origins
- **Rate limiting** prevents abuse
- **Environment variables** keep secrets secure
- **HTTPS only** in production

## 🛠️ Customization

### Adding New Event Types

Edit `server.js` to handle additional EventSub events:

```javascript
case 'channel.follow':
    handleFollowEvent(eventData);
    break;
```

### Custom Frontend Styling

The frontend uses vanilla CSS - edit styles in `public/index.html`.

### Database Integration

For persistent data, add database connection in `server.js`:

```javascript
// Example with PostgreSQL
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
```

## 📊 Monitoring & Analytics

- **Real-time connection count** via `/api/stats`
- **Server health monitoring** with built-in health checks
- **Event logging** for debugging and analytics
- **Automatic error reporting** and recovery

## 🤝 Contributing

1. **Fork the repository**
2. **Create feature branch**: `git checkout -b feature/amazing-feature`
3. **Commit changes**: `git commit -m 'Add amazing feature'`
4. **Push to branch**: `git push origin feature/amazing-feature`
5. **Open Pull Request**

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/twitch-giveaway-system/issues)
- **Documentation**: Check the `docs/` folder
- **Twitch API**: [Twitch Developer Docs](https://dev.twitch.tv/docs/)

## 🎉 Acknowledgments

- **Twitch** for the amazing EventSub API
- **Render** for free hosting with HTTPS
- **Contributors** who help improve this project

---

**Happy Streaming! 🎮✨**
