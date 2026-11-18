# API 启动前迁移

[英文说明](../self-host-configuration.md#migrate-when-the-api-process-starts)

`RAKAZO_MIGRATE_ON_START=true` 时，API 在监听之前执行已有的
`dist/cli/migrate-database.js`，退出码不是 0 就不启动。默认关闭。
这是本仓库的改动，不会改到公司 Bitbucket 上的 `feat/cicd-online`。

当前 SIT：命名空间 `itpai`，工作负载 `vertex-bot-sit`（副本数 1；滚动更新仍会重叠，靠迁移命令自己的数据库锁，不靠副本数）。
数据库 `vertexbot`。迁移登录 `vertexbot` 只放在 Secret 的 `DATABASE_MIGRATION_URL`。
运行时仍是 `rakazo_app`（`DATABASE_URL`），角色名不要改，权限也不扩大。

初次安装：

- `RAKAZO_MIGRATE_ON_START=true`
- `RAKAZO_DEPLOYED_MIGRATIONS` 为空字符串。这和“未设置”不同；进程不会替你改成空字符串。升级时不要把已记录的清单再写成空的。
- 两个 URL 都来自 Secret，不要写进镜像、参数或日志。

```yaml
workingDir: /app/apps/api
command: ["node", "--enable-source-maps", "dist/index.js"]
env:
  - name: RAKAZO_MIGRATE_ON_START
    value: "true"
  - name: RAKAZO_DEPLOYED_MIGRATIONS
    value: ""
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: vertex-bot-sit
        key: DATABASE_URL
  - name: DATABASE_MIGRATION_URL
    valueFrom:
      secretKeyRef:
        name: vertex-bot-sit
        key: DATABASE_MIGRATION_URL
```

`DATABASE_URL` 使用 `rakazo_app`，`DATABASE_MIGRATION_URL` 使用 `vertexbot`，库名都是 `vertexbot`。口令只放在 Secret 里。

再次启动会再跑同一条迁移命令，不会清空数据库。worker 不迁移，等 API 成功后再起。
生产环境不要开这个开关，用单独的 Job 在 `/app/apps/api` 运行 `node dist/cli/migrate-database.js`，成功后再滚动 API。
