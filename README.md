# ExamHub · 校园练习站

基于 Next.js、React、TypeScript 和 PostgreSQL 的校园练习应用。包含应用代码、数据库结构、测试，以及线上标注贡献者为 sol 的题库数据。第三方资料原件、资料索引、部署配置和本地密钥未包含在此仓库。

## 本地运行

需要 Node.js 22+ 和 PostgreSQL 16+。

```bash
npm ci
cp .env.example .env.local
# 配置独立 DATABASE_URL、随机生成的 ANSWER_KEY 及所需服务凭据
npm run db -- migrate
npm run db -- seed
npm run dev
```

`data/resources.json` 为空资料清单模板；`data/dsa-bank.json`、`data/exam-packs.json` 和 `data/exam-packs-agent.json` 为题库导入数据。按需使用 `scripts/` 下的导入脚本。

验证：`npm run typecheck`、`npm test`、`npm run build`。部分原有测试依赖未公开的第三方资料清单，可能需要自行准备相应测试数据。
