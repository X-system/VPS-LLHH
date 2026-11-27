# VPS 中文管理面板

支持中转机与出口机两种角色，入口协议限定为 VMess 原始 TCP 与 Hysteria2。

**开发中，尚未发布生产版本。不要用于替换现有生产面板。**

开发目录为 `D:\Codex\vps-panel`。本项目与原 VPS 运维目录完全分离，禁止复制生产凭证、用户口令、私钥或实际诊断记录到仓库。

## 本地开发

需要 Node.js 24。使用内置 HTTP、SQLite 与密码学模块，不需要数据库服务。

```sh
npm ci
npm run check
npm test
npm start
# 在另一个终端查看入口
node src/cli.mjs address
```

首次启动会生成随机管理员密码和强制随机入口。地址在本机终端显示；首次凭证保存在运行目录的 `.bootstrap.json`（0600权限），不写入服务日志。默认仅监听 `127.0.0.1:18443`，本地开发使用 HTTP；生产部署必须配置 HTTPS。运行数据存放于忽略提交的 `data/`。

## Linux安装与维护

当前安装器开放Debian12 amd64；Debian13正在隔离验收。安装会校验固定版本的Node、Xray及Hysteria下载，创建独立账户与系统服务，自动检查WG和防火墙能力。安装完成只启动管理服务，代理保持停止。

使用已经取得并检查的完整源码目录安装，例如：

```sh
bash /opt/vps-panel-source/install.sh --source /opt/vps-panel-source
```

首次管理HTTPS使用自签证书；登录网页后配置服务器角色、WG配对、协议和域名证书，再手动启动线路。需要公网管理时安装器检测本机IPv4和可用端口；隔离测试可通过VPS_INSTALL_BIND=127.0.0.1与VPS_INSTALL_IP=127.0.0.1限制为回环访问。

SSH输入`vps-panel`打开应急菜单。停止和急停可绕过网页及本机管理器；修复网页可重置管理服务的启动失败限制。完整安装的重复执行不会覆盖配置；未完成安装可保留数据重新部署程序。

卸载分为保留数据和清除数据。保留数据后恢复安装使用`install.sh --source /绝对源码目录 --restore`，沿用管理员、入口、用户和用量，代理保持急停并要求重新确认配对。

网页支持面板版本更新及回滚，变更期间代理停止，自检失败自动恢复。当前不自动升级Node或协议核心二进制，遇到组件摘要变化会拒绝该版本。项目目前仅作私人使用，未上传GitHub。现有下载引导和在线更新仅支持公开Release，尚未实现私有仓库授权；私有分发暂缓，不提供指向不存在仓库的一键下载命令。

## 文档

- [已确认需求](docs/requirements.md)
- [架构与开发状态](docs/architecture.md)
- [网页操作与界面约定](docs/ui-guide.md)
- [系统验收计划](docs/test-plan.md)
- [后续总控接口边界](docs/controller-contract.md)
- [后续AI辅助配置边界](docs/automation-contract.md)（设计预留，尚未实现）

本项目当前不公开源码，也未授予公开分发许可。若以后决定分发，需另行确认许可方式并检查依赖许可及敏感信息。
