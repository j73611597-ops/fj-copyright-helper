# 福建省作品自愿登记系统 - 强制PC版+自动登录+直达首页

Tampermonkey 油猴脚本，让「福建省作品自愿登记系统」在电脑上用得更顺手。

## 功能
- **强制桌面版**：从源头屏蔽站点对窗口变化的响应式切换（resize / orientationchange / matchMedia / 手动 dispatchEvent），缩窗、放大都不再跳手机版、不再整页刷新。
- **表单保险柜（FormKeeper）**：填报过程中实时备份输入，万一页面重载也能自动恢复，不丢数据；提交成功后自动清空草稿，不会把旧数据回填。
- **自动登录 + 自动回首页**：打开站点自动处理登录、过期弹窗，少点很多次。
- **心跳保活**：默认每 2 分钟保活一次，避免登录态意外过期。

## 安装
1. 浏览器安装 Tampermonkey 插件。
2. 把 `fj-copyright-auto-home.user.js` 拖进 Tampermonkey 管理页面，或在 GreasyFork 一键安装。
3. 打开 `http://copyright.fjxuanchuan.cn` 即可生效。

## 配置（网址参数）
在网址末尾加 `?参数名`（多个用 `&` 连接，无需等号），例如 `?nohome` 或 `?nohome&nologin`，可关闭某些功能：
- `?nohome` 关闭自动回首页
- `?nologin` 关闭自动登录
- `?noheartbeat` 关闭心跳保活
- `?nojump` 登录过期弹窗后改为原地重登（默认会跳登录页）

## 更新日志
### v18
- 事件源防火墙：拦截站点监听窗口变化的所有入口，使其感知不到窗口变小。
- FormKeeper 加固：提交/保存后能可靠清空草稿，避免旧数据复活。
- 控制台日志降噪：同类拦截日志最多 3 条，不再刷屏。

## 许可证
MIT © 2026 Heyden Lin
