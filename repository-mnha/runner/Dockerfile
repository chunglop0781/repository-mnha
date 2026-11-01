# Dịch vụ chạy C++ (runner). Build từ GỐC dự án:  docker build -f runner/Dockerfile -t mnha-runner .
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends g++ && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 runner
WORKDIR /app
COPY package.json ./
COPY config/codeConfig.js config/
COPY services/code/cppRunner.js services/code/
COPY runner/server.js runner/
USER runner
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "runner/server.js"]
