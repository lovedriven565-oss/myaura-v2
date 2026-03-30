# MyAURA Deployment Guide (VPS)

This guide covers deploying the MyAURA full-stack application to a standard Linux VPS using Node.js, PM2, and Nginx.

## 1. Prerequisites on VPS

Ensure the following are installed on your Ubuntu/Debian server:
- Node.js (v18 or v20 recommended)
- npm
- PM2 (\`npm install -g pm2\`)
- Nginx
- Git

## 2. Clone and Setup

SSH into your server and run:

\`\`\`bash
cd /var/www
git clone https://github.com/your-repo/myaura.git
cd myaura

# Install dependencies
npm install

# Copy environment variables and configure them
cp .env.example .env
nano .env
\`\`\`

**Important Env Vars:**
- `GEMINI_API_KEY`: Your Google Vertex AI / Gemini API key.
- `APP_URL`: Your production domain (e.g., `https://myaura.com`).
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL`: Cloudflare R2 credentials for object storage.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`: Supabase credentials for PostgreSQL database.

## 3. Database Setup

1. Go to your Supabase project dashboard.
2. Navigate to the SQL Editor.
3. Run the SQL script found in `supabase/migrations/20240328000000_init.sql` to create the `generations` table and set up RLS policies.

## 4. Build the Application

Build both the Vite frontend and the Express backend:

\`\`\`bash
npm run build
\`\`\`

This will generate:
- \`dist/index.html\` and assets (Frontend)
- \`dist/server.js\` (Backend bundled by esbuild)

## 4. Start with PM2

Start the application using the provided ecosystem file:

\`\`\`bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup # Follow the instructions to start PM2 on boot
\`\`\`

## 5. Nginx Reverse Proxy

Configure Nginx to route traffic to the Node.js app running on port 3000.

Create a new config file: \`sudo nano /etc/nginx/sites-available/myaura\`

\`\`\`nginx
server {
    listen 80;
    server_name myaura.com www.myaura.com;

    # Increase max body size for image uploads (10MB limit in app)
    client_max_body_size 15M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Pass real IP for rate limiting/logging
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
\`\`\`

Enable the site and restart Nginx:

\`\`\`bash
sudo ln -s /etc/nginx/sites-available/myaura /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
\`\`\`

## 6. SSL with Certbot (Optional but Recommended)

\`\`\`bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d myaura.com -d www.myaura.com
\`\`\`

## 7. Automated Deployment Script (deploy.sh)

You can create a simple script to pull updates and restart:

\`\`\`bash
#!/bin/bash
echo "Deploying MyAURA..."
cd /var/www/myaura
git pull origin main
npm install
npm run build
pm2 restart myaura-app
echo "Deployment complete!"
\`\`\`
