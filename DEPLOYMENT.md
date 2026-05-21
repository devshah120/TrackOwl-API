# Deployment Guide

Instructions for deploying TrackOwl Backend to production.

## Pre-Deployment Checklist

- [ ] All environment variables configured
- [ ] Database backups in place
- [ ] SSL certificate obtained
- [ ] API tested in staging
- [ ] Error logging configured
- [ ] Rate limiting enabled
- [ ] Security headers added
- [ ] CORS properly configured for production domain

## Environment Setup

### Production .env

```env
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/trackowl?retryWrites=true&w=majority
JWT_SECRET=your_very_long_random_secret_key_at_least_32_chars
PORT=5000
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.com
```

**Important:**
- Use MongoDB Atlas (cloud) for production
- Use a strong JWT_SECRET (min 32 characters)
- Set NODE_ENV=production
- Use HTTPS domain

## Deployment Platforms

### Option 1: Heroku (Easiest)

```bash
# Install Heroku CLI
npm install -g heroku

# Login
heroku login

# Create app
heroku create trackowl-api

# Set environment variables
heroku config:set MONGODB_URI=mongodb+srv://...
heroku config:set JWT_SECRET=your_secret_key
heroku config:set CORS_ORIGIN=https://yourdomain.com

# Deploy
git push heroku main

# View logs
heroku logs --tail
```

### Option 2: AWS (Scalable)

**Using Elastic Beanstalk:**

```bash
# Install EB CLI
pip install awsebcli

# Initialize
eb init -p node.js-20 trackowl-api

# Create environment
eb create trackowl-api-env

# Deploy
eb deploy
```

**Using ECS + Fargate:**

1. Create Docker image
2. Push to ECR
3. Create ECS service
4. Configure ALB
5. Update DNS

### Option 3: DigitalOcean (Cost-effective)

```bash
# Create droplet with Node.js
# SSH into droplet
ssh root@your_droplet_ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install MongoDB (or use Atlas)
# Clone repository
git clone your_repo_url
cd backend

# Install dependencies
npm install --production

# Create .env file
nano .env

# Install PM2
npm install -g pm2

# Start app
pm2 start server.js --name "trackowl-api"
pm2 save
pm2 startup

# Setup Nginx reverse proxy
# Setup SSL with Let's Encrypt
sudo apt-get install certbot
```

### Option 4: Railway (Easy)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link

# Deploy
railway up
```

## Docker Deployment

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
```

Create `.dockerignore`:

```
node_modules
.env
.env.*
.git
.gitignore
README.md
npm-debug.log
```

Build and run:

```bash
# Build
docker build -t trackowl-api:1.0 .

# Run locally
docker run -p 5000:5000 \
  -e MONGODB_URI=mongodb+srv://... \
  -e JWT_SECRET=... \
  trackowl-api:1.0

# Push to registry
docker tag trackowl-api:1.0 yourregistry/trackowl-api:1.0
docker push yourregistry/trackowl-api:1.0
```

## Production Best Practices

### 1. Security

Add security headers middleware:

```javascript
import helmet from 'helmet';

app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ limit: '10kb' }));
```

Add rate limiting:

```javascript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### 2. Logging

Add logging:

```javascript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console());
}
```

### 3. Database Backups

MongoDB Atlas automatically backs up data, but:

```bash
# Manual backup
mongodump --uri mongodb+srv://user:pass@cluster.mongodb.net/trackowl --out ./backup

# Restore
mongorestore --uri mongodb+srv://user:pass@cluster.mongodb.net/trackowl ./backup
```

### 4. Performance Optimization

- Enable gzip compression
- Cache responses where applicable
- Use CDN for static assets
- Optimize database queries
- Monitor response times

### 5. Monitoring

Setup monitoring with:

- **Datadog:** Application Performance Monitoring
- **New Relic:** Real-time monitoring
- **Sentry:** Error tracking
- **Grafana:** Dashboards

### 6. SSL/HTTPS

Use Let's Encrypt:

```bash
# On DigitalOcean/Linux
sudo apt-get install certbot python3-certbot-nginx
sudo certbot certonly --nginx -d yourdomain.com
```

Update Nginx config to use SSL:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Production Checklist

### Before Going Live

- [ ] Environment variables set in production
- [ ] Database backups configured
- [ ] Error monitoring setup (Sentry, etc)
- [ ] Performance monitoring enabled
- [ ] SSL certificate installed
- [ ] CORS properly configured
- [ ] Rate limiting enabled
- [ ] Security headers set (helmet)
- [ ] Logging configured
- [ ] Database indexes created
- [ ] API thoroughly tested
- [ ] Load testing completed
- [ ] Incident response plan ready
- [ ] Team trained on deployment process

### Monitoring After Deployment

- [ ] Check error logs daily
- [ ] Monitor response times
- [ ] Track API usage
- [ ] Review security logs
- [ ] Backup database regularly
- [ ] Check disk space
- [ ] Monitor CPU/memory usage
- [ ] Test recovery procedures

## Scaling

### Database Scaling

```javascript
// Add indexes for performance
userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });

// Enable read replicas in MongoDB Atlas
// Setup connection pooling
const connectionPool = 100;
```

### Application Scaling

```bash
# Use PM2 cluster mode
pm2 start server.js -i max --name "trackowl-api"

# Or use load balancer (Nginx)
upstream backend {
  server localhost:5000;
  server localhost:5001;
  server localhost:5002;
}
```

## Rollback Plan

If deployment fails:

```bash
# Heroku
heroku rollback v123

# DigitalOcean with Git
git revert HEAD
git push origin main

# Docker
docker run -p 5000:5000 trackowl-api:previous-version
```

## Common Issues

### High Memory Usage
- Check for memory leaks: `node --inspect server.js`
- Increase Node heap: `NODE_OPTIONS="--max-old-space-size=512"`
- Enable garbage collection: `--expose-gc`

### Slow Database Queries
- Add database indexes
- Use MongoDB explain() to analyze queries
- Cache frequently accessed data
- Use connection pooling

### High API Latency
- Enable response compression: `npm install compression`
- Optimize JSON responses (only send needed fields)
- Use database select: `User.find().select('name email')`
- Implement API caching

### CORS Issues in Production
- Update CORS_ORIGIN to production domain
- Ensure credentials: true if needed
- Check headers in response

## Performance Targets

- API Response time: < 200ms
- Database query time: < 100ms
- Error rate: < 0.1%
- Availability: > 99.9%
- Cold start time: < 1s

## Support & Monitoring URLs

After deployment, setup monitoring for:

- Application logs: See Heroku/DigitalOcean logs
- Error tracking: https://sentry.io
- Performance: https://newrelic.com
- Uptime monitoring: https://uptimerobot.com
- Status page: https://statuspage.io

---

For development deployment, follow QUICKSTART.md.
For local testing, run `npm run dev`.
