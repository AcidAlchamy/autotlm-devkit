# AutoTLM DevKit — SQLite kit container image.
# One stage, like the core kit's. Build from the REPO ROOT — the kit serves
# the root's public/ console and imports the root's src/config.js:
#
#   docker build -f kits/sqlite/Dockerfile -t autotlm-devkit-sqlite .
#   docker run -p 3801:3801 -v devkit-db:/app/kits/sqlite/data autotlm-devkit-sqlite
#
# Mount a volume over /app/kits/sqlite/data (as above) or the database dies
# with the container — which would rather miss the point of this kit.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY kits/sqlite/server.js ./kits/sqlite/server.js
COPY kits/sqlite/src ./kits/sqlite/src

EXPOSE 3801
CMD ["node", "kits/sqlite/server.js"]
