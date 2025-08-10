# Node + Debian so we can install Chromium & Python
FROM node:18-bullseye

# System deps for Chromium and Python/reportlab
RUN apt-get update && apt-get install -y \
  chromium \
  python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first (better caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps for PDF gen
RUN pip3 install --no-cache-dir reportlab

# Copy the rest of your source
COPY . .

# Puppeteer/Chromium path (whatsapp-web.js uses Puppeteer)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Make dirs that we’ll persist as volumes
RUN mkdir -p /app/.wwebjs_auth /app/pdfs

CMD ["node", "index.js"]