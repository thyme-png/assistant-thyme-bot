FROM node:20-alpine
RUN npm install -g @masumi_network/masumi-agent-messenger@0.0.24
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
