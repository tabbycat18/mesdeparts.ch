FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY realtime_api/backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY realtime_api/backend .

# Copy frontend static files to be served by backend
COPY realtime_api/frontend ./frontend

# Fly/containers expect PORT; your app should listen on it.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
