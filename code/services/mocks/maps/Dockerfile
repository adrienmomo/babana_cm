FROM node:22-alpine
WORKDIR /app
COPY services/mocks/maps/src ./src
COPY services/mocks/maps/fixtures ./fixtures
EXPOSE 4001
CMD ["node", "src/index.js"]
