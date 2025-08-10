# Dockerfile
FROM node:20-bookworm-slim

# Python (for reportlab) + runtime libs Chromium needs at runtime
RUN apt-get update && apt-get install -y \
  python3 python3-pip \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Let puppeteer download its own Chromium during npm install (default)
ENV PUPPETEER_SKIP_DOWNLOAD=false

WORKDIR /app

# Install Node deps first (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps for PDF generation
RUN pip3 install --no-cache-dir reportlab

# Copy the rest of your source
COPY . .

# Create persistent dirs (map via volumes in docker-compose)
RUN mkdir -p /app/.wwebjs_auth /app/pdfs

ENV NODE_ENV=production
CMD ["node", "index.js"]