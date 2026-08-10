FROM node:22-alpine
WORKDIR /app
COPY services/mocks/google-identity/src ./src
EXPOSE 4000
CMD ["node", "src/index.js"]
