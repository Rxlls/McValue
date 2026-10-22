# McValue 生产镜像
# 说明：本项目直接以 TypeScript 运行（tsx 已列为运行时依赖），因此镜像内只装生产依赖即可启动，
# 无需构建步骤，也不会把 vitest / typescript 等开发依赖带进镜像。
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173

# 先只拷贝依赖清单，利用层缓存：依赖不变时不会重复安装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web

# 以非 root 运行
USER node

EXPOSE 5173

# 健康检查：容器内自检，失败则由编排层重启
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
