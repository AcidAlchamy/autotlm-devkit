# AutoTLM DevKit — container image.
# The kit is a starter, so the image is too: one stage, no build step.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js simulate.js ./
COPY src ./src
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
