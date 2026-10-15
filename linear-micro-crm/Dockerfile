# Linear Hub — production image (API + built client on one port)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000 NODE_NO_WARNINGS=1
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/client/package.json ./client/package.json
RUN npm ci --omit=dev --no-audit --no-fund -w shared -w server && mkdir -p server/data
EXPOSE 4000
VOLUME ["/app/server/data"]
CMD ["npm", "start"]
