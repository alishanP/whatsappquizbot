# Dockerfile
FROM node:20-bookworm-slim

# System deps: Python + build tools + libs Puppeteer/Chromium needs
RUN apt-get update && apt-get install -y \
  python3 python3-venv python3-dev build-essential \
  libfreetype6-dev libjpeg62-turbo-dev zlib1g-dev libffi-dev \
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

# Let Puppeteer download Chromium during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=false

WORKDIR /app

# Install Node deps first (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Python venv for reportlab (avoids PEP 668 issues) ----
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/py/bin/pip install --no-cache-dir reportlab \
 && ln -s /opt/py/bin/python /usr/local/bin/python3 \
 && ln -s /opt/py/bin/pip /usr/local/bin/pip3
# -----------------------------------------------------------

RUN pip3 install --no-cache-dir reportlab

# Copy the rest of your source
COPY . .

# Persisted dirs (mounted via docker-compose volumes)
RUN mkdir -p /app/.wwebjs_auth /app/pdfs

ENV NODE_ENV=production
CMD ["node", "index.js"]