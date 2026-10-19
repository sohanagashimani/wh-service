# Multi-stage Dockerfile for Google Cloud Run deployment

# Stage 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy application source code
COPY src ./src

# Compile TypeScript to JavaScript in /dist
RUN npm run build

# Stage 2: Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Use non-root node user for security
USER node

# Expose HTTP port (Google Cloud Run injects $PORT, default 8080)
EXPOSE 8080

# Start production server
CMD ["node", "dist/server.js"]
